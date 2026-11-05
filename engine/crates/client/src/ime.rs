//! Typing into a field: class names, player names, room codes, chat — in Korean, so through the
//! platform's input method (IME), never raw key codes (Hangul is composed: ㅎ → 하 → 한).
//!
//! - Android: GameActivity's GameTextInput owns the text while the soft keyboard is up; we hand it
//!   the field's value when focusing ([`begin`]) and read its whole state every frame ([`poll`]).
//!   winit 0.30 drops GameActivity's TextEvent, which is why this polls android-activity directly.
//! - Desktop: winit's `Ime::Preedit/Commit` events and plain key text feed [`TextEdit`].
//!
//! [`TextEdit`] is the platform-free part (limits, composing text, backspace), unit-tested.

/// One line being edited: what is committed plus what the IME is still composing.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextEdit {
    pub text: String,
    /// The syllable still being composed (shown, not yet part of `text`).
    pub preedit: String,
    /// The most characters the field takes (a name: 16, a class: 20, chat: 120).
    pub max: usize,
}

impl TextEdit {
    pub fn new(initial: &str, max: usize) -> Self {
        let mut e = Self { text: String::new(), preedit: String::new(), max };
        e.set(initial);
        e
    }

    /// What the field shows: the committed text and the composing syllable.
    pub fn shown(&self) -> String {
        format!("{}{}", self.text, self.preedit)
    }

    /// Replace everything (the platform's own copy changed). Control characters are dropped and
    /// the length is capped, like the server's schemas (`[^\p{C}]`, max length).
    pub fn set(&mut self, s: &str) {
        self.text = clean(s).chars().take(self.max).collect();
        self.preedit.clear();
    }

    pub fn commit(&mut self, s: &str) {
        self.preedit.clear();
        for c in clean(s).chars() {
            if self.text.chars().count() >= self.max {
                break;
            }
            self.text.push(c);
        }
    }

    pub fn backspace(&mut self) {
        if !self.preedit.is_empty() {
            self.preedit.pop();
        } else {
            self.text.pop();
        }
    }

    /// The value to send (trimmed, as the server trims).
    pub fn value(&self) -> String {
        self.text.trim().to_owned()
    }
}

/// The byte offset of UTF-16 position `units` in `s` (None past the end or inside a surrogate pair).
pub fn utf16_to_byte(s: &str, units: usize) -> Option<usize> {
    let mut n = 0;
    for (byte, c) in s.char_indices() {
        if n == units {
            return Some(byte);
        }
        n += c.len_utf16();
        if n > units {
            return None;
        }
    }
    (n == units).then_some(s.len())
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

#[cfg(target_os = "android")]
mod platform {
    use std::sync::OnceLock;
    use winit::platform::android::activity::input::{ImeOptions, InputType, TextInputAction, TextInputState, TextSpan};
    use winit::platform::android::activity::AndroidApp;

    static APP: OnceLock<AndroidApp> = OnceLock::new();

    pub fn install(app: &AndroidApp) {
        let _ = APP.set(app.clone());
    }

    pub fn app() -> Option<&'static AndroidApp> {
        APP.get()
    }

    pub fn begin(initial: &str) {
        if let Some(app) = APP.get() {
            // GameTextInput positions are UTF-16 units (Java string indices), not bytes
            let end = initial.encode_utf16().count();
            app.set_text_input_state(TextInputState { text: initial.to_owned(), selection: TextSpan { start: end, end }, compose_region: None });
            // winit drops GameActivity's IME action (the keyboard's ✓): a multi-line field makes
            // that key type a newline instead, which sync() reads as "submit"
            app.set_ime_editor_info(InputType::TYPE_CLASS_TEXT | InputType::TYPE_TEXT_FLAG_MULTI_LINE, TextInputAction::None, ImeOptions::IME_FLAG_NO_ENTER_ACTION);
            app.show_soft_input(true);
        }
    }

    pub fn end() {
        if let Some(app) = APP.get() {
            app.hide_soft_input(false);
        }
    }

    /// The IME's whole text (composing part included) and the composing range in UTF-16 units.
    pub fn poll() -> Option<(String, Option<(usize, usize)>)> {
        let state = APP.get()?.text_input_state();
        let compose = state.compose_region.map(|r| (r.start, r.end));
        Some((state.text, compose))
    }

    /// Put a capped value back into the IME (typing past the limit).
    pub fn replace(text: &str) {
        begin(text);
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    pub fn begin(_: &str) {}
    pub fn end() {}
    pub fn poll() -> Option<(String, Option<(usize, usize)>)> {
        None
    }
    pub fn replace(_: &str) {}
}

#[cfg(target_os = "android")]
pub use platform::{app, install};

/// Start editing: on a phone, the soft keyboard comes up holding `initial`.
pub fn begin(initial: &str) {
    platform::begin(initial);
}

/// Stop editing (hide the soft keyboard).
pub fn end() {
    platform::end();
}

/// What a frame of typing did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Synced {
    Same,
    Changed,
    /// The keyboard's Enter / ✓ (a newline arrived): the field is done.
    Submit,
}

/// Android: copy the IME's state into `edit` (call once a frame while a field is focused).
pub fn sync(edit: &mut TextEdit) -> Synced {
    let Some((full, compose)) = platform::poll() else { return Synced::Same };
    if full.contains('\n') {
        let text: String = full.replace('\n', "");
        edit.set(&text);
        platform::replace(&edit.text);
        return Synced::Submit;
    }
    let span = compose.and_then(|(a, b)| Some((utf16_to_byte(&full, a)?, utf16_to_byte(&full, b)?))).filter(|(a, b)| a < b);
    let (text, preedit) = match span {
        Some((a, b)) => (format!("{}{}", &full[..a], &full[b..]), full[a..b].to_owned()),
        None => (full.clone(), String::new()),
    };
    let before = (edit.text.clone(), edit.preedit.clone());
    edit.set(&text);
    edit.preedit = clean(&preedit);
    if edit.text != text {
        // over the limit or a control character: hand the IME the cleaned value
        platform::replace(&edit.text);
    }
    if before != (edit.text.clone(), edit.preedit.clone()) { Synced::Changed } else { Synced::Same }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_and_composition() {
        let mut e = TextEdit::new("김", 4);
        e.preedit = "ㅁ".into();
        assert_eq!(e.shown(), "김ㅁ");
        e.commit("민수야아");
        assert_eq!(e.text, "김민수야", "capped at 4 characters, not bytes");
        assert!(e.preedit.is_empty());
        e.backspace();
        assert_eq!(e.text, "김민수");
        e.preedit = "ㅎ".into();
        e.backspace();
        assert_eq!((e.text.as_str(), e.preedit.as_str()), ("김민수", ""), "backspace eats the composing jamo first");
        e.set("a\u{7}b\nc  ");
        assert_eq!(e.text, "abc ");
        assert_eq!(e.value(), "abc");
    }

    #[test]
    fn utf16_positions_map_to_bytes() {
        assert_eq!(utf16_to_byte("한글ab", 0), Some(0));
        assert_eq!(utf16_to_byte("한글ab", 2), Some(6), "two 3-byte syllables");
        assert_eq!(utf16_to_byte("한글ab", 4), Some(8));
        assert_eq!(utf16_to_byte("한글ab", 5), None);
        assert_eq!(utf16_to_byte("a🦖b", 1), Some(1));
        assert_eq!(utf16_to_byte("a🦖b", 2), None, "inside the emoji surrogate pair");
        assert_eq!(utf16_to_byte("a🦖b", 3), Some(5));
    }

    #[test]
    fn sync_is_harmless_without_a_platform_ime() {
        let mut e = TextEdit::new("x", 8);
        assert_eq!(sync(&mut e), Synced::Same);
        assert_eq!(e.text, "x");
    }
}
