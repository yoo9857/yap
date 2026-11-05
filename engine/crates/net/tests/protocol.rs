//! The Rust wire types against the zod schemas: `fixtures.json` is generated from them by
//! `tools/engine-protocol.mjs` (every variant, with every optional field and with none). Each one
//! must decode and encode back to the same JSON — a field the Rust side lacks would be dropped.

use craftyap_net::protocol::*;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures.json")).expect("fixtures.json")
}

/// JSON equality with numbers compared as numbers (Rust writes 4.0 where JavaScript writes 4).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn round_trip<T: DeserializeOwned + Serialize>(group: &str) -> usize {
    let all = fixtures();
    let list = all[group].as_array().unwrap_or_else(|| panic!("{group} missing"));
    assert!(!list.is_empty(), "{group} has no fixtures");
    for original in list {
        let text = original.to_string();
        let msg: T = decode(&text).unwrap_or_else(|| panic!("{group}: Rust cannot read {text}"));
        let back: Value = serde_json::from_str(&encode(&msg)).unwrap();
        assert!(same(original, &back), "{group}: changed on the way back\n  zod:  {original}\n  rust: {back}");
    }
    list.len()
}

#[test]
fn versions_match_typescript() {
    let all = fixtures();
    assert_eq!(all["versions"]["party"], PARTY_PROTOCOL_VERSION, "PARTY_PROTOCOL_VERSION");
    assert_eq!(all["versions"]["class"], CLASS_PROTOCOL_VERSION, "CLASS_PROTOCOL_VERSION");
}

#[test]
fn party_round_trips() {
    assert!(round_trip::<PartyClient>("partyClient") >= 12);
    assert!(round_trip::<PartyServer>("partyServer") >= 7);
}

#[test]
fn classroom_round_trips() {
    assert!(round_trip::<ClassClient>("classClient") >= 13);
    assert!(round_trip::<ClassServer>("classServer") >= 17);
}

#[test]
fn held_item_null_and_absent_stay_apart() {
    let null: ClassServer = decode(r#"{"t":"s-k-snap","players":[{"id":"a","pos":[0,0,0],"yaw":0,"anim":"idle","heldItem":null}]}"#).unwrap();
    let absent: ClassServer = decode(r#"{"t":"s-k-snap","players":[{"id":"a","pos":[0,0,0],"yaw":0,"anim":"idle"}]}"#).unwrap();
    let held = |m: &ClassServer| match m {
        ClassServer::Snap { players, .. } => players[0].look.held_item.clone(),
        _ => unreachable!(),
    };
    assert_eq!(held(&null), Some(None));
    assert_eq!(held(&absent), None);
}

#[test]
fn a_newer_server_does_not_break_this_build() {
    // an unknown field and an unknown enum value are read, not refused
    let msg: Option<PartyServer> = decode(r#"{"t":"s-p-rooms","rooms":[{"code":"ABCDEF","title":"x","game":"racing","host":"h","players":1,"max":8,"state":"playing","badge":"new"}],"page":2}"#);
    assert!(matches!(msg, Some(PartyServer::Rooms { ref rooms }) if rooms[0].game == "racing"));
    // an unknown message type is skipped (None), never a panic
    assert!(decode::<ClassServer>(r#"{"t":"s-k-fireworks","n":3}"#).is_none());
}

#[test]
fn malformed_input_is_refused_quietly() {
    for raw in ["", "null", "[]", "{", r#"{"t":"s-k-edit","by":"a","edits":[[1,2,3]]}"#, r#"{"t":"s-k-world","edits":[[1,300,3,4,5]]}"#,
        r#"{"t":"s-k-furniture","furniture":[["chair",1,2,3,0,0,1,9]]}"#, r#"{"t":"s-k-welcome"}"#] {
        assert!(decode::<ClassServer>(raw).is_none(), "accepted {raw:?}");
    }
    let huge = format!(r#"{{"t":"s-k-chat","from":"a","name":"b","role":"student","text":"{}"}}"#, "x".repeat(MAX_SERVER_MESSAGE));
    assert!(decode::<ClassServer>(&huge).is_none());
}

#[test]
fn class_key_matches_the_web() {
    assert_eq!(class_key("  햇살   반 "), "햇살 반");
    assert_eq!(class_key("Kim\tClass"), "kim class");
    assert_eq!(party_field_name("ABCDEF"), "party:ABCDEF");
}
