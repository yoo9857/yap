//! One WebSocket connection on its own thread. The game thread never blocks on the network: it
//! queues text frames with [`Link::send`] and drains [`Event`]s with [`Link::poll`] once a frame.
//!
//! A link is ONE connection. It does not reconnect by itself — after a drop the first message must
//! be sent again (with a seat or host key), and only the session above knows it — so a dead link
//! reports [`Event::Closed`] once and the session opens a new one after its back-off.
//!
//! Load-bearing:
//! - Connect and handshake are bounded ([`LinkOptions::connect_timeout`]); a phone on a bad network
//!   must see "can't connect" in seconds, never a frozen loading screen.
//! - The watchdog closes a link that has been silent for [`LinkOptions::silence_limit`] (the server
//!   promises traffic every `keepalive` seconds), so a half-open TCP connection — a phone that
//!   changed networks — is noticed instead of waiting minutes for the OS.
//! - The outgoing queue is bounded. A full queue drops the frame (and logs): game traffic is
//!   repeated state (moves) or answered by the server (edits get rejects), and unbounded memory
//!   during a stall is worse than one lost frame.

use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::Once;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::{Message, WebSocket};

/// What the game sees of a link.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The handshake finished; the queued first message has gone out.
    Open,
    /// One text frame from the server (decode it with `protocol::decode`).
    Text(String),
    /// The link is gone; nothing more arrives. `opened`: it had been [`Event::Open`].
    Closed { opened: bool, why: CloseWhy },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CloseWhy {
    /// We closed it ([`Link::close`] or drop).
    Local,
    /// The server closed it, with its close code and reason (e.g. 4000 "replaced").
    Server { code: u16, reason: String },
    /// No connection could be made in time (DNS, refused, TLS, handshake).
    Unreachable(String),
    /// The server went quiet for longer than it promised.
    Silent,
    /// The connection broke (reset, I/O error).
    Broken(String),
}

#[derive(Debug, Clone)]
pub struct LinkOptions {
    pub connect_timeout: Duration,
    /// Close when nothing (not even a ping) arrives for this long. None = no watchdog.
    pub silence_limit: Option<Duration>,
    pub queue: usize,
    pub max_message: usize,
}

impl Default for LinkOptions {
    fn default() -> Self {
        Self { connect_timeout: Duration::from_secs(8), silence_limit: Some(Duration::from_secs(30)), queue: 512, max_message: crate::protocol::MAX_SERVER_MESSAGE }
    }
}

enum Cmd {
    Text(String),
    Silence(Option<Duration>),
    Close,
}

pub struct Link {
    tx: SyncSender<Cmd>,
    rx: Receiver<Event>,
    thread: Option<JoinHandle<()>>,
    closed: bool,
}

impl Link {
    /// Start connecting to `url` (`ws://` or `wss://`). `first` goes out right after the handshake,
    /// before anything queued with [`Link::send`].
    pub fn open(url: &str, first: Option<String>, opts: LinkOptions) -> Link {
        let (tx, cmd_rx) = mpsc::sync_channel(opts.queue.max(1));
        let (ev_tx, rx) = mpsc::channel();
        let url = url.to_owned();
        let thread = std::thread::Builder::new()
            .name("craftyap-link".into())
            .spawn(move || run(&url, first, &opts, &cmd_rx, &ev_tx))
            .ok();
        if thread.is_none() {
            log::error!("link: could not start the network thread");
        }
        Link { tx, rx, thread, closed: false }
    }

    /// Queue a text frame. False when it was dropped (queue full, or the link is gone).
    pub fn send(&self, text: String) -> bool {
        match self.tx.try_send(Cmd::Text(text)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                log::warn!("link: send queue full, frame dropped");
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    /// Change the watchdog (the welcome's `keepalive` × 5).
    pub fn set_silence_limit(&self, limit: Option<Duration>) {
        let _ = self.tx.try_send(Cmd::Silence(limit));
    }

    /// Everything that happened since the last poll. After `Closed` the list stays empty.
    pub fn poll(&mut self) -> Vec<Event> {
        let mut out = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(ev) => {
                    if matches!(ev, Event::Closed { .. }) {
                        self.closed = true;
                    }
                    out.push(ev);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !self.closed {
                        // the thread died without a word (it panicked): still tell the caller once
                        self.closed = true;
                        out.push(Event::Closed { opened: false, why: CloseWhy::Broken("network thread ended".into()) });
                    }
                    break;
                }
            }
        }
        out
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn close(&mut self) {
        // a full queue still sees the closed sender when the thread next looks
        let _ = self.tx.try_send(Cmd::Close);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.close();
        // the thread wakes at least every READ_TICK; never join a thread stuck in connect (it is
        // bounded by connect_timeout and exits on its own)
        drop(self.thread.take());
    }
}

/// How long one read waits before the thread looks at its queue again: the latency floor of an
/// outgoing frame. 15 ms keeps a 60 Hz client's moves going out in the frame they were made.
const READ_TICK: Duration = Duration::from_millis(15);

struct Target {
    tls: bool,
    host: String,
    port: u16,
}

fn parse(url: &str) -> Result<Target, String> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("wss://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("ws://") {
        (false, r)
    } else {
        return Err(format!("not a ws:// or wss:// url: {url}"));
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h, p.parse::<u16>().map_err(|_| format!("bad port in {url}"))?),
        _ => (authority, if tls { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err(format!("no host in {url}"));
    }
    Ok(Target { tls, host: host.trim_matches(['[', ']']).to_owned(), port })
}

fn install_crypto() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // ring, not aws-lc: aws-lc needs cmake + NASM in the Android NDK build
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

type Socket = WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

fn connect(url: &str, opts: &LinkOptions) -> Result<Socket, String> {
    let target = parse(url)?;
    let deadline = Instant::now() + opts.connect_timeout;
    let addrs: Vec<_> = (target.host.as_str(), target.port).to_socket_addrs().map_err(|e| format!("dns: {e}"))?.collect();
    let mut last = String::from("no address");
    let mut stream = None;
    for addr in addrs {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&addr, left) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = format!("{addr}: {e}"),
        }
    }
    let stream = stream.ok_or(last)?;
    let _ = stream.set_nodelay(true);
    // the handshake (TLS + HTTP upgrade) gets what is left of the budget
    let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(500));
    stream.set_read_timeout(Some(left)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(left)).map_err(|e| e.to_string())?;
    if target.tls {
        install_crypto();
    }
    let config = WebSocketConfig::default().max_message_size(Some(opts.max_message)).max_frame_size(Some(opts.max_message));
    let (socket, _response) = tungstenite::client_tls_with_config(url, stream, Some(config), None).map_err(|e| format!("handshake: {e}"))?;
    let raw = match socket.get_ref() {
        tungstenite::stream::MaybeTlsStream::Plain(s) => s,
        tungstenite::stream::MaybeTlsStream::Rustls(s) => s.get_ref(),
        _ => return Err("unsupported stream".into()),
    };
    raw.set_read_timeout(Some(READ_TICK)).map_err(|e| e.to_string())?;
    raw.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    Ok(socket)
}

fn would_block(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut))
}

fn run(url: &str, first: Option<String>, opts: &LinkOptions, cmds: &Receiver<Cmd>, events: &mpsc::Sender<Event>) {
    let mut socket = match connect(url, opts) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("link: {url} unreachable: {e}");
            let _ = events.send(Event::Closed { opened: false, why: CloseWhy::Unreachable(e) });
            return;
        }
    };
    if let Some(text) = first {
        if let Err(e) = socket.send(Message::text(text)) {
            let _ = events.send(Event::Closed { opened: false, why: CloseWhy::Broken(e.to_string()) });
            return;
        }
    }
    let _ = events.send(Event::Open);
    let mut silence = opts.silence_limit;
    let mut heard = Instant::now();
    let why = 'session: loop {
        // outgoing first: a move made this frame leaves before we wait on the read
        loop {
            match cmds.try_recv() {
                Ok(Cmd::Text(text)) => {
                    if let Err(e) = socket.write(Message::text(text)) {
                        if !would_block(&e) {
                            break 'session CloseWhy::Broken(e.to_string());
                        }
                    }
                }
                Ok(Cmd::Silence(limit)) => {
                    silence = limit;
                    heard = Instant::now();
                }
                Ok(Cmd::Close) | Err(TryRecvError::Disconnected) => {
                    let _ = socket.close(Some(CloseFrame { code: CloseCode::Normal, reason: "bye".into() }));
                    let _ = socket.flush();
                    break 'session CloseWhy::Local;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        if let Err(e) = socket.flush() {
            if !would_block(&e) {
                break CloseWhy::Broken(e.to_string());
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                heard = Instant::now();
                if events.send(Event::Text(text.as_str().to_owned())).is_err() {
                    break CloseWhy::Local; // the game dropped the link
                }
            }
            Ok(Message::Close(frame)) => {
                let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.as_str().to_owned())).unwrap_or((1005, String::new()));
                break CloseWhy::Server { code, reason };
            }
            // pings are answered by tungstenite on the next flush; they still prove the link lives
            Ok(_) => heard = Instant::now(),
            Err(e) if would_block(&e) => {}
            Err(tungstenite::Error::ConnectionClosed) => break CloseWhy::Server { code: 1000, reason: String::new() },
            Err(e) => break CloseWhy::Broken(e.to_string()),
        }
        if silence.is_some_and(|limit| heard.elapsed() > limit) {
            log::warn!("link: {url} silent for {:?}, closing", heard.elapsed());
            break CloseWhy::Silent;
        }
    };
    if !matches!(why, CloseWhy::Local) {
        log::info!("link: {url} closed: {why:?}");
    }
    let _ = events.send(Event::Closed { opened: true, why });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let t = parse("wss://craftyap.com/ws?mode=party").unwrap();
        assert!(t.tls && t.host == "craftyap.com" && t.port == 443);
        let t = parse("ws://127.0.0.1:8081/ws").unwrap();
        assert!(!t.tls && t.host == "127.0.0.1" && t.port == 8081);
        let t = parse("ws://[::1]:9000/ws").unwrap();
        assert!(t.host == "::1" && t.port == 9000);
        assert!(parse("http://x").is_err() && parse("ws://").is_err() && parse("ws://h:99999/").is_err());
    }

    #[test]
    fn unreachable_is_reported_quickly() {
        // a port nothing listens on: refused, well inside the timeout
        let start = Instant::now();
        let mut link = Link::open("ws://127.0.0.1:9/ws", None, LinkOptions { connect_timeout: Duration::from_secs(3), ..Default::default() });
        let mut got = Vec::new();
        while start.elapsed() < Duration::from_secs(5) && !link.is_closed() {
            got.extend(link.poll());
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(got.as_slice(), [Event::Closed { opened: false, why: CloseWhy::Unreachable(_) }]), "{got:?}");
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(!link.send("late".into()) || link.is_closed());
    }

    #[test]
    fn silly_input_never_panics() {
        let mut link = Link::open("nonsense", None, LinkOptions::default());
        let start = Instant::now();
        while !link.is_closed() && start.elapsed() < Duration::from_secs(2) {
            link.poll();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(link.is_closed());
    }
}
