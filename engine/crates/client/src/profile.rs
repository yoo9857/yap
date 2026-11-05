//! What the app remembers between launches, like the web's localStorage: the player's name, the
//! party seat (back into the room after a game or a restart), and the key each class handed out
//! (a refresh re-takes the same seat; a teacher re-opens their class with the host key).
//!
//! One small JSON file in the app's private folder (Android `files/`, desktop `%APPDATA%/CraftYap`
//! or `CRAFTYAP_DATA`). Read defensively: a missing, corrupt or hand-edited file is an empty
//! profile, never a crash, and every value is re-checked (names 1–16 characters, keys ≤ 64).

use craftyap_net::protocol::{class_key, Seat};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const NAME_MAX: usize = 16;
pub const CLASS_MAX: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    pub name: String,
    pub seat: Option<Seat>,
    /// "<class key>|teacher" or "<class key>|student" → the key the class gave us.
    pub class_keys: BTreeMap<String, String>,
    pub last_class: String,
    /// The adopted pet (creatureRig.ts species key; anything unknown reads as the dog).
    pub pet: String,
    /// The character (character.ts CHARACTER_IDS: "mascot" = HOME, "tt"); anything else: HOME.
    pub character: String,
    /// The field's hotbar as loaded from the bag (inventory.ts CLASS_HOTBAR_KEY); empty: the default.
    pub field_bar: Vec<String>,
    /// The player's settings (the web's ui/settings.ts record, field for field where it applies).
    /// Read on its own: a broken record is the defaults, never a lost name and class keys.
    #[serde(deserialize_with = "lenient_settings")]
    pub settings: Settings,
}

fn lenient_settings<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Settings, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// ui/settings.ts SENSITIVITY_RANGE.
pub const SENSITIVITY_RANGE: (f64, f64) = (0.3, 2.5);

/// The web's settings, the ones the app has: graphics preset, look speed, effects volume, invert Y.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "auto" | "low" | "medium" | "high" (auto starts from the device and steps down when slow).
    pub graphics: String,
    /// Multiplier on the base look speed (0.3–2.5).
    pub sensitivity: f64,
    /// 0–1, scales every sound effect.
    pub sfx: f64,
    /// Dragging up looks down.
    pub invert_y: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { graphics: "auto".into(), sensitivity: 1.0, sfx: 1.0, invert_y: false }
    }
}

impl Settings {
    /// Every value back in range (a hand-edited or newer file never breaks the app).
    pub fn clamped(mut self) -> Settings {
        let fin = |v: f64, lo: f64, hi: f64, d: f64| if v.is_finite() { v.clamp(lo, hi) } else { d };
        if !["auto", "low", "medium", "high"].contains(&self.graphics.as_str()) {
            self.graphics = "auto".into();
        }
        self.sensitivity = fin(self.sensitivity, SENSITIVITY_RANGE.0, SENSITIVITY_RANGE.1, 1.0);
        self.sfx = fin(self.sfx, 0.0, 1.0, 1.0);
        self
    }
}

impl Default for Profile {
    /// A first launch: no name yet, the dog (as the web's fresh island).
    fn default() -> Self {
        Profile { name: String::new(), seat: None, class_keys: BTreeMap::new(), last_class: String::new(), pet: "dog".into(), character: "mascot".into(), field_bar: Vec::new(), settings: Settings::default() }
    }
}

/// The app's private folder (profile, island save).
pub fn data_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CRAFTYAP_DATA") {
        return Some(PathBuf::from(d));
    }
    #[cfg(target_os = "android")]
    {
        crate::ime::app().and_then(|a| a.internal_data_path())
    }
    #[cfg(not(target_os = "android"))]
    {
        std::env::var("APPDATA").or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.config"))).ok().map(|base| PathBuf::from(base).join("CraftYap"))
    }
}

fn valid_name(s: &str, max: usize) -> bool {
    let n = s.trim().chars().count();
    n >= 1 && n <= max && !s.chars().any(char::is_control)
}

impl Profile {
    fn path() -> Option<PathBuf> {
        data_dir().map(|d| d.join("profile.json"))
    }

    pub fn load() -> Profile {
        let Some(path) = Self::path() else { return Profile::default() };
        match std::fs::read_to_string(&path) {
            Ok(text) => Self::parse(&text),
            Err(_) => Profile::default(),
        }
    }

    /// A stored profile, cleaned: anything invalid is dropped, not trusted.
    pub fn parse(text: &str) -> Profile {
        let mut p: Profile = serde_json::from_str(text).unwrap_or_default();
        if !valid_name(&p.name, NAME_MAX) {
            p.name.clear();
        }
        p.name = p.name.trim().to_owned();
        if p.seat.as_ref().is_some_and(|s| s.code.len() != 6 || s.key.len() < 8 || s.key.len() > 64) {
            p.seat = None;
        }
        p.class_keys.retain(|k, v| k.len() <= 128 && !v.is_empty() && v.len() <= 64);
        if !valid_name(&p.last_class, CLASS_MAX) {
            p.last_class.clear();
        }
        p.pet = crate::pet::species_or_dog(&p.pet).to_owned();
        p.settings = p.settings.clone().clamped();
        if p.character != "tt" {
            p.character = "mascot".into();
        }
        p
    }

    /// Write it (atomically: a crash mid-write leaves the old file). Failure is logged, not fatal.
    pub fn save(&self) {
        let Some(path) = Self::path() else { return };
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap_or_default())?;
            std::fs::rename(&tmp, &path)
        };
        if let Err(e) = write() {
            log::warn!("profile not saved: {e}");
        }
    }

    pub fn class_seat(&self, room: &str, teacher: bool) -> Option<String> {
        self.class_keys.get(&Self::seat_id(room, teacher)).cloned()
    }

    pub fn set_class_seat(&mut self, room: &str, teacher: bool, key: Option<String>) {
        let id = Self::seat_id(room, teacher);
        match key {
            Some(k) => {
                self.class_keys.insert(id, k);
            }
            None => {
                self.class_keys.remove(&id);
            }
        }
        // the saved roster keeps 200 seats; a device does not need more than 50 classes
        while self.class_keys.len() > 50 {
            let first = self.class_keys.keys().next().cloned();
            if let Some(k) = first {
                self.class_keys.remove(&k);
            }
        }
    }

    fn seat_id(room: &str, teacher: bool) -> String {
        format!("{}|{}", class_key(room), if teacher { "teacher" } else { "student" })
    }
}

pub fn valid_player_name(s: &str) -> bool {
    valid_name(s, NAME_MAX)
}

pub fn valid_class_name(s: &str) -> bool {
    valid_name(s, CLASS_MAX)
}

/// The server: `wss://craftyap.com`, or CRAFTYAP_SERVER (desktop) / a `server` file holding the
/// address in the app's private folder (debuggable Android builds, e.g. ws://10.0.2.2:8081 for the
/// emulator reaching the PC's `pnpm dev`).
pub fn server() -> String {
    if let Ok(s) = std::env::var("CRAFTYAP_SERVER") {
        return s.trim_end_matches('/').to_owned();
    }
    #[cfg(target_os = "android")]
    if let Some(s) = crate::ime::app().and_then(|a| a.internal_data_path()).and_then(|d| std::fs::read_to_string(d.join("server")).ok()) {
        let s = s.trim().trim_end_matches('/');
        if s.starts_with("ws://") || s.starts_with("wss://") {
            return s.to_owned();
        }
    }
    "wss://craftyap.com".to_owned()
}

/// A query value, percent-encoded (class names are Korean: `?room=햇살반`).
pub fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_or_broken_files_are_an_empty_profile() {
        for text in ["", "{", "null", "[1,2]", r#"{"name":5}"#] {
            assert_eq!(Profile::parse(text), Profile::default(), "{text}");
        }
        let p = Profile::parse(r#"{"name":"  민지 ","seat":{"code":"ABC","key":"short"},"class_keys":{"x":""},"last_class":"이것은스무자를훨씬넘는아주아주긴반이름입니다"}"#);
        assert_eq!(p.name, "민지");
        assert!(p.seat.is_none() && p.class_keys.is_empty() && p.last_class.is_empty());
        assert_eq!(Profile::parse(r#"{"name":"이름이열여섯자를넘어가는사람입니다요"}"#).name, "");
        assert_eq!(Profile::parse(r#"{"name":"a\u0007b"}"#).name, "");
    }

    #[test]
    fn settings_are_read_defensively_like_parse_settings() {
        let p = Profile::parse(r#"{"settings":{"graphics":"ultra","sensitivity":9,"sfx":-1,"invertY":true}}"#);
        assert_eq!(p.settings, Settings { graphics: "auto".into(), sensitivity: 2.5, sfx: 0.0, invert_y: true });
        let p = Profile::parse(r#"{"name":"민지","settings":"broken"}"#);
        assert_eq!(p.settings, Settings::default(), "a broken record is the defaults");
        assert_eq!(p.name, "민지", "and the rest of the profile survives it");
        let p = Profile::parse(r#"{"name":"민지","settings":{"sfx":"loud"}}"#);
        assert_eq!((p.name.as_str(), p.settings.sfx), ("민지", 1.0));
        assert_eq!(Profile::parse(r#"{"name":"민지"}"#).settings, Settings::default());
    }

    #[test]
    fn class_seats_are_keyed_like_the_web() {
        let mut p = Profile::default();
        p.set_class_seat("햇살  반", false, Some("seat1".into()));
        assert_eq!(p.class_seat("햇살 반", false).as_deref(), Some("seat1"), "case/space-insensitive like classKey");
        assert!(p.class_seat("햇살 반", true).is_none(), "teacher and student keys are separate");
        for i in 0..80 {
            p.set_class_seat(&format!("반{i}"), true, Some("k".into()));
        }
        assert_eq!(p.class_keys.len(), 50);
        let back = Profile::parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back, p);
    }

    #[test]
    fn room_names_are_url_encoded() {
        assert_eq!(url_encode("party:ABC"), "party%3AABC");
        assert_eq!(url_encode("햇살 반"), "%ED%96%87%EC%82%B4%20%EB%B0%98");
    }
}
