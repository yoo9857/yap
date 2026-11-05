//! Read-only reachability probe: `cargo run -p craftyap-net --example probe -- wss://craftyap.com`
//! Says hello to the party hub and prints the public room list. Creates nothing.
use std::time::{Duration, Instant};
use craftyap_net::link::{Event, Link, LinkOptions};
use craftyap_net::protocol::*;

fn main() {
    let base = std::env::args().nth(1).unwrap_or_else(|| "wss://craftyap.com".into());
    let started = Instant::now();
    let hello = PartyClient::Hello { v: PARTY_PROTOCOL_VERSION, name: "probe".into(), seat: None };
    let mut link = Link::open(&format!("{base}/ws?mode=party"), Some(encode(&hello)), LinkOptions::default());
    while started.elapsed() < Duration::from_secs(10) {
        for ev in link.poll() {
            match ev {
                Event::Open => println!("open after {:?}", started.elapsed()),
                Event::Text(t) => match decode::<PartyServer>(&t) {
                    Some(PartyServer::Welcome { .. }) => { link.send(encode(&PartyClient::List)); }
                    Some(PartyServer::Rooms { rooms }) => {
                        println!("{} public rooms after {:?}", rooms.len(), started.elapsed());
                        link.close();
                        return;
                    }
                    other => println!("{other:?}"),
                },
                Event::Closed { why, .. } => { println!("closed: {why:?}"); return; }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    println!("timed out");
}
