//! The party hub as the app's screens see it: one state the loading screen, the lobby and the
//! waiting room are drawn from, kept in step with the server. Same rules as the web's
//! `net/partyClient.ts`:
//!
//! - Anything sent before the server's welcome waits in a queue (a tap right after connecting is
//!   never lost); `p-list` is not queued, it is re-sent on every welcome while listing.
//! - A dropped link reconnects with a back-off of 0.5 s doubling to 8 s, and the hello carries the
//!   seat (room code + key), so a phone that lost signal is back in its room with its seat.
//! - `bad-version` stops for good: this build is too old, and retrying cannot fix that.
//! - Starting a game hands over the seat and closes the hub link; the seat stays for the way back.
//!
//! Time and the connection are injected ([`Connect`], `now`), so every rule is unit-tested.

use std::time::Duration;

use crate::link::{CloseWhy, Event};
use crate::protocol::*;

/// The part of a [`crate::link::Link`] the hub uses (a fake in tests).
pub trait Wire {
    fn send(&self, text: String) -> bool;
    fn poll(&mut self) -> Vec<Event>;
}

impl Wire for crate::link::Link {
    fn send(&self, text: String) -> bool {
        crate::link::Link::send(self, text)
    }
    fn poll(&mut self) -> Vec<Event> {
        crate::link::Link::poll(self)
    }
}

/// Opens a connection to `/ws?mode=party` with this first message.
pub type Connect = Box<dyn FnMut(String) -> Box<dyn Wire>>;

#[derive(Debug, Clone, PartialEq)]
pub enum HubState {
    /// A connection attempt is under way (`attempt` 0 = the first).
    Connecting { attempt: u32 },
    /// No connection; the next attempt is at `retry_at` (seconds on the hub's clock).
    Offline { retry_at: f64, attempt: u32, why: String },
    /// Connected, not in a room.
    Lobby,
    /// Seated in a room (the waiting room, or a room that is playing).
    Room,
    /// The server is newer than this build: the app must be updated.
    UpdateRequired,
    /// Into a game: the hub link is closed and the seat kept.
    Starting { game: String, code: String },
}

/// Things that happened, for the screens to show once (toasts, chat lines).
#[derive(Debug, Clone, PartialEq)]
pub enum HubNote {
    Error(String),
    Chat { from: String, name: String, text: String, system: bool },
    Left(String),
}

pub struct Hub {
    connect: Connect,
    wire: Option<Box<dyn Wire>>,
    name: String,
    pub state: HubState,
    /// Our player id on the hub (changes per connection).
    pub you: String,
    /// The live public room list (while listing).
    pub rooms: Vec<PartySummary>,
    /// The room we sit in, and which member is us.
    pub room: Option<PartyRoom>,
    pub seat_id: String,
    seat: Option<Seat>,
    listing: bool,
    welcomed: bool,
    queue: Vec<PartyClient>,
    attempt: u32,
    notes: Vec<HubNote>,
}

/// The back-off before attempt `n` (n ≥ 1): 0.5 s doubling, capped at 8 s (partyClient.ts).
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((500u64 << attempt.saturating_sub(1).min(5)).min(8000))
}

impl Hub {
    /// Connects right away. `seat` re-takes a seat kept from before (back from a game).
    pub fn new(connect: Connect, name: &str, seat: Option<Seat>) -> Hub {
        let mut hub = Hub {
            connect,
            wire: None,
            name: name.to_owned(),
            state: HubState::Connecting { attempt: 0 },
            you: String::new(),
            rooms: Vec::new(),
            room: None,
            seat_id: String::new(),
            seat,
            listing: false,
            welcomed: false,
            queue: Vec::new(),
            attempt: 0,
            notes: Vec::new(),
        };
        hub.dial();
        hub
    }

    /// The seat to keep (persist it: a restarted app re-takes it).
    pub fn seat(&self) -> Option<&Seat> {
        self.seat.as_ref()
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn take_notes(&mut self) -> Vec<HubNote> {
        std::mem::take(&mut self.notes)
    }

    fn dial(&mut self) {
        self.welcomed = false;
        let hello = PartyClient::Hello { v: PARTY_PROTOCOL_VERSION, name: self.name.clone(), seat: self.seat.clone() };
        self.wire = Some((self.connect)(encode(&hello)));
        self.state = HubState::Connecting { attempt: self.attempt };
    }

    /// Run once a frame with the hub's clock (seconds).
    pub fn tick(&mut self, now: f64) {
        if let HubState::Offline { retry_at, .. } = self.state {
            if now >= retry_at {
                self.dial();
            }
            return;
        }
        let events = match self.wire.as_mut() {
            Some(wire) => wire.poll(),
            None => return,
        };
        for ev in events {
            match ev {
                Event::Open => {}
                Event::Text(text) => {
                    if let Some(msg) = decode::<PartyServer>(&text) {
                        self.receive(msg);
                    }
                    // a start hands over to the game: the room update the server sends right
                    // after it (state "playing") must not turn the hub back into "in a room"
                    if matches!(self.state, HubState::Starting { .. } | HubState::UpdateRequired) {
                        return;
                    }
                }
                Event::Closed { why, .. } => {
                    self.wire = None;
                    self.welcomed = false;
                    if matches!(self.state, HubState::UpdateRequired | HubState::Starting { .. }) || why == CloseWhy::Local {
                        return;
                    }
                    self.attempt += 1;
                    let wait = backoff(self.attempt).as_secs_f64();
                    self.state = HubState::Offline { retry_at: now + wait, attempt: self.attempt, why: describe(&why) };
                    return;
                }
            }
        }
    }

    fn receive(&mut self, msg: PartyServer) {
        match msg {
            PartyServer::Welcome { you } => {
                self.you = you;
                self.welcomed = true;
                self.attempt = 0;
                // a seat we asked for arrives as s-p-room right after; until then we are in the lobby
                self.state = HubState::Lobby;
                for queued in std::mem::take(&mut self.queue) {
                    self.raw_send(&queued);
                }
                if self.listing {
                    self.raw_send(&PartyClient::List);
                }
            }
            PartyServer::Rooms { rooms } => self.rooms = rooms,
            PartyServer::Room { room, key, you } => {
                self.seat = Some(Seat { code: room.code.clone(), key });
                self.seat_id = you;
                self.room = Some(room);
                self.state = HubState::Room;
            }
            PartyServer::Left { reason } => {
                self.seat = None;
                self.room = None;
                self.state = HubState::Lobby;
                self.notes.push(HubNote::Left(reason));
            }
            PartyServer::Start { game, code } => {
                // the seat stays (the way back re-takes it); the hub link is not needed in a game
                self.queue.clear();
                self.wire = None;
                self.state = HubState::Starting { game, code };
            }
            PartyServer::Chat { from, name, text, system } => self.notes.push(HubNote::Chat { from, name, text, system: system.unwrap_or(false) }),
            PartyServer::Error { code } => {
                if code == "bad-version" {
                    self.wire = None;
                    self.state = HubState::UpdateRequired;
                } else if code == "not-found" || code == "kicked" {
                    // a seat that no longer exists: forget it so the next hello does not ask again
                    if self.room.is_none() {
                        self.seat = None;
                    }
                }
                self.notes.push(HubNote::Error(code));
            }
        }
    }

    fn raw_send(&mut self, msg: &PartyClient) {
        if let Some(wire) = &self.wire {
            wire.send(encode(msg));
        }
    }

    /// Send now when welcomed, else after the welcome. `p-list` is never queued (it is re-sent on
    /// every welcome while listing). Nothing is sent once the app must update or a game started.
    pub fn send(&mut self, msg: PartyClient) {
        if matches!(self.state, HubState::UpdateRequired | HubState::Starting { .. }) {
            return;
        }
        if self.welcomed && self.wire.is_some() {
            self.raw_send(&msg);
        } else if msg != PartyClient::List {
            self.queue.push(msg);
        }
    }

    pub fn list(&mut self) {
        self.listing = true;
        self.send(PartyClient::List);
    }

    /// Leave the room for good (the seat is given up).
    pub fn leave(&mut self) {
        self.seat = None;
        self.send(PartyClient::Leave);
    }

    /// Try again now (the "retry" button on the offline screen).
    pub fn retry_now(&mut self, now: f64) {
        if let HubState::Offline { attempt, why, .. } = &self.state {
            self.state = HubState::Offline { retry_at: now, attempt: *attempt, why: why.clone() };
        }
    }

    /// Back from a game: reconnect to the hub with the kept seat.
    pub fn resume(&mut self) {
        if matches!(self.state, HubState::Starting { .. }) {
            self.attempt = 0;
            self.dial();
        }
    }

    /// Our own entry in the room's member list.
    pub fn me(&self) -> Option<&PartyMember> {
        self.room.as_ref()?.members.iter().find(|m| m.id == self.seat_id)
    }

    pub fn is_host(&self) -> bool {
        self.room.as_ref().is_some_and(|r| r.host == self.seat_id)
    }
}

fn describe(why: &CloseWhy) -> String {
    match why {
        CloseWhy::Local => "closed".into(),
        CloseWhy::Server { code, reason } => format!("server closed ({code} {reason})"),
        CloseWhy::Unreachable(e) => format!("unreachable: {e}"),
        CloseWhy::Silent => "no answer from the server".into(),
        CloseWhy::Broken(e) => format!("connection lost: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// One fake connection: what was sent on it, and events the test feeds in.
    #[derive(Default)]
    struct FakeLine {
        sent: Vec<String>,
        inbox: Vec<Event>,
    }
    struct FakeWire(Rc<RefCell<FakeLine>>);
    impl Wire for FakeWire {
        fn send(&self, text: String) -> bool {
            self.0.borrow_mut().sent.push(text);
            true
        }
        fn poll(&mut self) -> Vec<Event> {
            std::mem::take(&mut self.0.borrow_mut().inbox)
        }
    }

    /// Every connection the hub opened, newest last: (first message, line).
    type Dials = Rc<RefCell<Vec<(String, Rc<RefCell<FakeLine>>)>>>;

    fn hub(seat: Option<Seat>) -> (Hub, Dials) {
        let dials: Dials = Rc::default();
        let d = dials.clone();
        let connect: Connect = Box::new(move |first| {
            let line = Rc::new(RefCell::new(FakeLine::default()));
            d.borrow_mut().push((first, line.clone()));
            Box::new(FakeWire(line))
        });
        (Hub::new(connect, "민수", seat), dials)
    }
    fn feed(dials: &Dials, msg: PartyServer) {
        dials.borrow().last().unwrap().1.borrow_mut().inbox.push(Event::Text(encode(&msg)));
    }
    fn drop_line(dials: &Dials) {
        dials.borrow().last().unwrap().1.borrow_mut().inbox.push(Event::Closed { opened: true, why: CloseWhy::Broken("reset".into()) });
    }
    fn sent(dials: &Dials) -> Vec<String> {
        dials.borrow().last().unwrap().1.borrow().sent.clone()
    }
    fn room(code: &str, members: &[(&str, bool)]) -> PartyRoom {
        PartyRoom {
            code: code.into(),
            title: "방".into(),
            game: "build".into(),
            max: 8,
            public: true,
            state: "waiting".into(),
            host: "s1".into(),
            members: members.iter().map(|(id, ready)| PartyMember { id: (*id).into(), name: (*id).into(), ready: *ready, online: true }).collect(),
        }
    }

    #[test]
    fn hello_then_queue_until_welcome() {
        let (mut h, dials) = hub(None);
        assert!(dials.borrow()[0].0.contains(r#""t":"p-hello""#) && !dials.borrow()[0].0.contains("seat"));
        h.list();
        h.send(PartyClient::Join { code: "ABCDEF".into() });
        assert!(sent(&dials).is_empty(), "nothing goes out before the welcome");
        feed(&dials, PartyServer::Welcome { you: "u1".into() });
        h.tick(0.0);
        assert_eq!(h.state, HubState::Lobby);
        assert_eq!(sent(&dials), vec![r#"{"t":"p-join","code":"ABCDEF"}"#.to_string(), r#"{"t":"p-list"}"#.to_string()]);
    }

    #[test]
    fn room_list_and_seat_follow_the_server() {
        let (mut h, dials) = hub(None);
        feed(&dials, PartyServer::Welcome { you: "u1".into() });
        feed(&dials, PartyServer::Rooms { rooms: vec![PartySummary { code: "ABCDEF".into(), title: "t".into(), game: "build".into(), host: "h".into(), players: 2, max: 8, state: "waiting".into() }] });
        feed(&dials, PartyServer::Room { room: room("ABCDEF", &[("s1", true), ("s2", false)]), key: "key-12345678".into(), you: "s2".into() });
        h.tick(0.0);
        assert_eq!(h.rooms.len(), 1);
        assert_eq!(h.state, HubState::Room);
        assert_eq!(h.seat(), Some(&Seat { code: "ABCDEF".into(), key: "key-12345678".into() }));
        assert!(!h.me().unwrap().ready && !h.is_host());
        feed(&dials, PartyServer::Left { reason: "kicked".into() });
        h.tick(0.1);
        assert!(h.seat().is_none() && h.room.is_none() && h.state == HubState::Lobby);
        assert_eq!(h.take_notes(), vec![HubNote::Left("kicked".into())]);
    }

    #[test]
    fn reconnects_with_backoff_and_retakes_the_seat() {
        let (mut h, dials) = hub(None);
        feed(&dials, PartyServer::Welcome { you: "u1".into() });
        feed(&dials, PartyServer::Room { room: room("ABCDEF", &[("s1", false)]), key: "key-12345678".into(), you: "s1".into() });
        h.tick(0.0);
        drop_line(&dials);
        h.tick(10.0);
        assert!(matches!(h.state, HubState::Offline { attempt: 1, .. }));
        h.tick(10.4);
        assert_eq!(dials.borrow().len(), 1, "not before the 0.5 s back-off");
        h.tick(10.5);
        assert_eq!(dials.borrow().len(), 2);
        assert!(dials.borrow()[1].0.contains(r#""seat":{"code":"ABCDEF","key":"key-12345678"}"#), "{}", dials.borrow()[1].0);
        // a second drop before any welcome waits longer
        drop_line(&dials);
        h.tick(11.0);
        assert!(matches!(h.state, HubState::Offline { retry_at, attempt: 2, .. } if (retry_at - 12.0).abs() < 1e-9));
        // the welcome resets the back-off
        h.tick(12.0);
        feed(&dials, PartyServer::Welcome { you: "u2".into() });
        h.tick(12.1);
        drop_line(&dials);
        h.tick(13.0);
        assert!(matches!(h.state, HubState::Offline { attempt: 1, .. }));
        assert_eq!(backoff(1), Duration::from_millis(500));
        assert_eq!(backoff(5), Duration::from_millis(8000));
        assert_eq!(backoff(40), Duration::from_millis(8000));
    }

    #[test]
    fn retry_now_skips_the_wait() {
        let (mut h, dials) = hub(None);
        drop_line(&dials);
        h.tick(0.0);
        for _ in 0..4 {
            h.tick(100.0);
            drop_line(&dials);
            h.tick(100.0);
        }
        h.retry_now(100.0);
        h.tick(100.0);
        assert!(matches!(h.state, HubState::Connecting { .. }));
    }

    #[test]
    fn bad_version_stops_for_good() {
        let (mut h, dials) = hub(None);
        feed(&dials, PartyServer::Error { code: "bad-version".into() });
        h.tick(0.0);
        assert_eq!(h.state, HubState::UpdateRequired);
        h.send(PartyClient::Chat { text: "x".into() });
        for t in [1.0, 10.0, 100.0] {
            h.tick(t);
        }
        assert_eq!(dials.borrow().len(), 1, "never redials");
    }

    #[test]
    fn start_hands_over_and_resume_comes_back_to_the_room() {
        let (mut h, dials) = hub(None);
        feed(&dials, PartyServer::Welcome { you: "u1".into() });
        feed(&dials, PartyServer::Room { room: room("ABCDEF", &[("s1", true)]), key: "key-12345678".into(), you: "s1".into() });
        feed(&dials, PartyServer::Start { game: "build".into(), code: "ABCDEF".into() });
        h.tick(0.0);
        assert_eq!(h.state, HubState::Starting { game: "build".into(), code: "ABCDEF".into() });
        assert!(h.seat().is_some(), "the seat is kept for the way back");
        h.tick(50.0);
        assert_eq!(dials.borrow().len(), 1, "no hub link while in a game");
        h.resume();
        assert_eq!(dials.borrow().len(), 2);
        assert!(dials.borrow()[1].0.contains("ABCDEF"));
    }

    #[test]
    fn the_room_update_right_after_a_start_does_not_cancel_it() {
        // the server's order on p-start: s-p-start, then room.sync() (state playing), one batch
        let (mut h, dials) = hub(None);
        feed(&dials, PartyServer::Welcome { you: "u1".into() });
        feed(&dials, PartyServer::Room { room: room("ABCDEF", &[("s1", true)]), key: "key-12345678".into(), you: "s1".into() });
        h.tick(0.0);
        feed(&dials, PartyServer::Start { game: "build".into(), code: "ABCDEF".into() });
        let mut playing = room("ABCDEF", &[("s1", true)]);
        playing.state = "playing".into();
        feed(&dials, PartyServer::Room { room: playing, key: "key-12345678".into(), you: "s1".into() });
        h.tick(1.0);
        assert_eq!(h.state, HubState::Starting { game: "build".into(), code: "ABCDEF".into() });
    }

    #[test]
    fn a_stale_seat_is_forgotten() {
        let (mut h, dials) = hub(Some(Seat { code: "GONE22".into(), key: "key-12345678".into() }));
        assert!(dials.borrow()[0].0.contains("GONE22"));
        feed(&dials, PartyServer::Welcome { you: "u1".into() });
        feed(&dials, PartyServer::Error { code: "not-found".into() });
        h.tick(0.0);
        assert!(h.seat().is_none());
        assert_eq!(h.take_notes(), vec![HubNote::Error("not-found".into())]);
    }
}
