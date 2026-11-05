//! The native client's online flow against a REAL server (`pnpm dev`, or any deployment):
//!
//!   CRAFTYAP_LIVE=ws://127.0.0.1:8081 cargo test -p craftyap-net --test live -- --nocapture
//!
//! Skipped without CRAFTYAP_LIVE. Two players do what the app's screens do: hub → room list →
//! create / join → ready → start → both enter the room's build field → each sees the other move.

use std::time::{Duration, Instant};

use craftyap_net::link::{Event, Link, LinkOptions};
use craftyap_net::protocol::*;

fn base() -> Option<String> {
    std::env::var("CRAFTYAP_LIVE").ok().map(|s| s.trim_end_matches('/').to_owned())
}

struct Peer<T> {
    link: Link,
    inbox: Vec<T>,
    name: &'static str,
    closed: Option<String>,
}

impl<T: for<'de> serde::Deserialize<'de> + std::fmt::Debug> Peer<T> {
    fn open(url: String, first: impl serde::Serialize, name: &'static str) -> Self {
        Peer { link: Link::open(&url, Some(encode(&first)), LinkOptions::default()), inbox: Vec::new(), name, closed: None }
    }
    fn send(&self, msg: impl serde::Serialize) {
        assert!(self.link.send(encode(&msg)));
    }
    fn pump(&mut self) {
        for ev in self.link.poll() {
            match ev {
                Event::Text(text) => match decode::<T>(&text) {
                    Some(msg) => self.inbox.push(msg),
                    None => panic!("{}: could not read a server message: {text:.300}", self.name),
                },
                // a close is only a failure if what we wait for never came (k-peek answers, then closes)
                Event::Closed { why, .. } => self.closed = Some(format!("{why:?}")),
                Event::Open => {}
            }
        }
    }
    /// Wait for the first message `pick` accepts (earlier ones are kept for later waits).
    fn wait<R>(&mut self, what: &str, mut pick: impl FnMut(&T) -> Option<R>) -> R {
        let start = Instant::now();
        loop {
            self.pump();
            if let Some(i) = self.inbox.iter().position(|m| pick(m).is_some()) {
                let msg = self.inbox.remove(i);
                return pick(&msg).unwrap();
            }
            if let Some(why) = &self.closed {
                panic!("{}: closed ({why}) before {what}; got {:?}", self.name, self.inbox);
            }
            assert!(start.elapsed() < Duration::from_secs(10), "{}: no {what} in 10 s; got {:?}", self.name, self.inbox);
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn party_room_into_shared_field() {
    let Some(base) = base() else {
        eprintln!("CRAFTYAP_LIVE not set: skipped");
        return;
    };
    let stamp = std::process::id() % 10_000;
    let (name_a, name_b): (&'static str, &'static str) = (Box::leak(format!("앱A{stamp}").into_boxed_str()), Box::leak(format!("앱B{stamp}").into_boxed_str()));
    let hub = format!("{base}/ws?mode=party");

    // A opens a public build room
    let mut a: Peer<PartyServer> = Peer::open(hub.clone(), PartyClient::Hello { v: PARTY_PROTOCOL_VERSION, name: name_a.into(), seat: None }, "A");
    a.wait("welcome", |m| matches!(m, PartyServer::Welcome { .. }).then_some(()));
    a.send(PartyClient::Create { title: format!("앱 테스트 {stamp}"), game: game::BUILD.into(), max: 8, public: true });
    let (code, key_a) = a.wait("own room", |m| match m {
        PartyServer::Room { room, key, .. } => Some((room.code.clone(), key.clone())),
        _ => None,
    });
    println!("room {code}");

    // B sees it in the live list and joins
    let mut b: Peer<PartyServer> = Peer::open(hub, PartyClient::Hello { v: PARTY_PROTOCOL_VERSION, name: name_b.into(), seat: None }, "B");
    b.wait("welcome", |m| matches!(m, PartyServer::Welcome { .. }).then_some(()));
    b.send(PartyClient::List);
    b.wait("room in the list", |m| match m {
        PartyServer::Rooms { rooms } => rooms.iter().any(|r| r.code == code && r.players == 1 && r.state == "waiting").then_some(()),
        _ => None,
    });
    b.send(PartyClient::Join { code: code.clone() });
    b.wait("joined room", |m| matches!(m, PartyServer::Room { room, .. } if room.members.len() == 2).then_some(()));
    a.wait("B seated", |m| match m {
        PartyServer::Room { room, .. } => room.members.iter().any(|p| p.name == name_b).then_some(()),
        _ => None,
    });

    // ready + chat + start
    b.send(PartyClient::Ready { ready: true });
    a.wait("B ready", |m| match m {
        PartyServer::Room { room, .. } => room.members.iter().any(|p| p.name == name_b && p.ready).then_some(()),
        _ => None,
    });
    b.send(PartyClient::Chat { text: "앱에서 왔어요".into() });
    a.wait("chat", |m| matches!(m, PartyServer::Chat { text, .. } if text == "앱에서 왔어요").then_some(()));
    a.send(PartyClient::Start);
    for peer in [&mut a, &mut b] {
        peer.wait("start", |m| matches!(m, PartyServer::Start { game, code: c } if game == "build" && *c == code).then_some(()));
    }

    // both enter the room's field (a classroom field named party:CODE)
    let field = party_field_name(&code);
    let class_url = format!("{base}/ws?mode=class&room={}", field.replace(':', "%3A"));
    let join = |student: &str| ClassClient::Join { v: CLASS_PROTOCOL_VERSION, room: field.clone(), student: student.into(), seat_key: None };
    let mut fa: Peer<ClassServer> = Peer::open(class_url.clone(), join(name_a), "fieldA");
    let (you_a, keepalive) = fa.wait("welcome", |m| match m {
        ClassServer::Welcome { you, edit_count, keepalive, .. } => {
            assert_eq!(*edit_count, 0, "a new party field is empty");
            Some((you.clone(), *keepalive))
        }
        _ => None,
    });
    println!("field welcome, keepalive {keepalive:?}");
    let mut fb: Peer<ClassServer> = Peer::open(class_url, join(name_b), "fieldB");
    fb.wait("welcome", |m| matches!(m, ClassServer::Welcome { .. }).then_some(()));

    // A moves; B's snapshots carry A there
    let target = [3.5, 9.0, -2.25];
    let start = Instant::now();
    let seen = loop {
        fa.send(ClassClient::Move { pos: target, yaw: 0.5, anim: "run".into(), ct: None, look: Presentation::default() });
        fa.pump();
        fa.inbox.clear();
        fb.pump();
        let hit = fb.inbox.iter().find_map(|m| match m {
            ClassServer::Snap { players, .. } => players.iter().find(|p| p.id == you_a && (p.pos[0] - target[0]).abs() < 0.01).cloned(),
            _ => None,
        });
        fb.inbox.retain(|m| !matches!(m, ClassServer::Snap { .. }));
        if let Some(p) = hit {
            break p;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "B never saw A move");
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(seen.anim, "run");

    // B places a block; A gets it in absolute coordinates
    fb.send(ClassClient::Edit { edits: vec![Edit(4, 2, -3, 3, 0)] });
    fa.wait("B's edit", |m| matches!(m, ClassServer::Edit { edits, .. } if edits.contains(&Edit(4, 2, -3, 3, 0))).then_some(()));
    println!("party {code}: list, join, ready, chat, start, field, moves and edits all synced (seat key {} chars)", key_a.len());
}

#[test]
fn peek_and_errors_from_the_live_server() {
    let Some(base) = base() else { return };
    let mut p: Peer<ClassServer> = Peer::open(format!("{base}/ws?mode=class&room=nope"), ClassClient::Peek { v: CLASS_PROTOCOL_VERSION, room: "없는반앱테스트".into() }, "peek");
    p.wait("room answer", |m| matches!(m, ClassServer::Room { exists: false, open: false, .. }).then_some(()));
    // an outdated client is told so, never left hanging
    let mut old: Peer<PartyServer> = Peer::open(format!("{base}/ws?mode=party"), PartyClient::Hello { v: 0, name: "old".into(), seat: None }, "old");
    old.wait("bad-version", |m| matches!(m, PartyServer::Error { code } if code == "bad-version").then_some(()));
}
