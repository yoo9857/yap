//! Text for the overlay: the web's font (Jua, `engine/assets/fonts`, SIL OFL 1.1 — the licence
//! ships beside it) rasterised by ab_glyph at the exact pixel size each label is drawn at, into one
//! R8 atlas the overlay shader reads with `textureLoad`. Pixel-exact glyphs are as sharp as the
//! platform's own text at any density.
//!
//! - Glyphs are made when first drawn and kept (Hangul has 11 172 syllables; a screen uses dozens).
//!   A full atlas is cleared at the start of the next frame and refilled from what is on screen.
//! - Jua has the 2 350 common syllables (KS X 1001) but not all 11 172, nor `·` or `…`. The rest
//!   comes from the system's CJK font (Android: Noto Sans CJK, Windows: Malgun Gothic). That font
//!   is 12–32 MB, so it is read on a background thread at start; until it is in, a missing
//!   character is skipped for that frame (never cached as missing). No fallback: skipped, no crash.
//! - ab_glyph, not fontdue: Android's Noto CJK has CFF outlines, which fontdue draws as nothing.
//! - Sizes are em sizes (CSS `font-size`), not ab_glyph's ascent-to-descent `PxScale`.
//! - A lost GPU device loses the atlas texture: the app calls [`Text::reset`] with the new renderer.

use ab_glyph::{Font, FontArc, FontVec, PxScale, ScaleFont};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// The atlas is ATLAS × ATLAS texels (R8: 4 MB). At 18–40 px that holds thousands of glyphs.
pub const ATLAS: u32 = 2048;
const PAD: u32 = 1;

const JUA: &[u8] = include_bytes!("../../../assets/fonts/Jua-Regular.ttf");

/// System fonts tried, in order, for characters Jua lacks.
const FALLBACKS: &[&str] = &[
    "/system/fonts/NotoSansCJK-Regular.ttc",
    "/system/fonts/NotoSansKR-Regular.otf",
    "/system/fonts/DroidSansFallback.ttf",
    "C:/Windows/Fonts/malgun.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
];

/// A rectangle of new glyph pixels for the GPU atlas.
pub struct Upload {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub data: Vec<u8>,
}

/// Where a glyph sits in the atlas and how it sits on the baseline (all in pixels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glyph {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// From the pen position to the bitmap's left edge.
    pub left: i32,
    /// From the baseline UP to the bitmap's top edge.
    pub top: i32,
    pub advance: f32,
}

/// One glyph placed on a line: its pen x (pixels from the line start, whole pixels) and atlas cell.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub x: f32,
    pub glyph: Glyph,
}

/// Which font draws a character.
enum Pick {
    Font(FontArc),
    /// Only the fallback has it, and the fallback is still loading: try again next frame.
    Later,
    None,
}

pub struct Text {
    primary: Option<FontArc>,
    /// Set once by the loader thread: Some(font), or None when no system font could be read.
    fallback: Arc<OnceLock<Option<FontArc>>>,
    cache: HashMap<(char, u16), Option<Glyph>>,
    shelf_x: u32,
    shelf_y: u32,
    shelf_h: u32,
    full: bool,
    pending: Vec<Upload>,
}

fn has(font: &FontArc, c: char) -> bool {
    font.glyph_id(c).0 != 0
}

/// ab_glyph's PxScale is the font's ascent-to-descent height; the UI is laid out in em sizes.
fn em(font: &FontArc, px: f32) -> PxScale {
    let units = font.units_per_em().unwrap_or(1000.0);
    PxScale::from(px * font.height_unscaled() / units)
}

impl Default for Text {
    fn default() -> Self {
        Self::new()
    }
}

impl Text {
    pub fn new() -> Self {
        let t = std::time::Instant::now();
        let primary = FontArc::try_from_slice(JUA).ok();
        match &primary {
            Some(_) => log::info!("font ready in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0),
            None => log::error!("the compiled-in Jua font cannot be read: labels use the system font"),
        }
        let fallback: Arc<OnceLock<Option<FontArc>>> = Arc::default();
        let slot = fallback.clone();
        let started = std::thread::Builder::new().name("font-fallback".into()).spawn(move || {
            let t = std::time::Instant::now();
            let found = FALLBACKS.iter().find_map(|path| {
                let bytes = std::fs::read(path).ok()?;
                let font = FontVec::try_from_vec_and_index(bytes, 0).ok()?;
                log::info!("text fallback font: {path} ({:.0} ms)", t.elapsed().as_secs_f64() * 1000.0);
                Some(FontArc::new(font))
            });
            if found.is_none() {
                log::warn!("no system CJK font: characters Jua lacks are skipped");
            }
            let _ = slot.set(found);
        });
        if started.is_err() {
            let _ = fallback.set(None);
        }
        Self { primary, fallback, cache: HashMap::new(), shelf_x: 0, shelf_y: 0, shelf_h: 0, full: false, pending: Vec::new() }
    }

    /// Wait for the fallback font (tests; the app never blocks on it).
    #[cfg(test)]
    fn wait_fallback(&self) -> bool {
        while self.fallback.get().is_none() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        matches!(self.fallback.get(), Some(Some(_)))
    }

    /// Start a frame: a full atlas is emptied (what this frame draws is made again).
    pub fn begin_frame(&mut self) {
        if self.full {
            log::info!("text atlas full: refilled");
            self.reset();
        }
    }

    /// Forget every glyph (a new GPU device, or a full atlas).
    pub fn reset(&mut self) {
        self.cache.clear();
        self.shelf_x = 0;
        self.shelf_y = 0;
        self.shelf_h = 0;
        self.full = false;
        self.pending.clear();
    }

    /// New glyph pixels since the last call, for the GPU.
    pub fn take_uploads(&mut self) -> Vec<Upload> {
        std::mem::take(&mut self.pending)
    }

    fn pick(&self, c: char) -> Pick {
        if let Some(f) = self.primary.as_ref().filter(|f| has(f, c)) {
            return Pick::Font(f.clone());
        }
        match self.fallback.get() {
            Some(Some(f)) if has(f, c) => Pick::Font(f.clone()),
            Some(_) => Pick::None,
            None => Pick::Later,
        }
    }

    #[cfg(test)]
    fn drawable(&self, c: char) -> bool {
        matches!(self.pick(c), Pick::Font(_))
    }

    /// Ascent and descent (descent negative) of a line at `px`.
    pub fn line_metrics(&self, px: f32) -> (f32, f32) {
        self.primary.as_ref().map_or((px * 0.8, -px * 0.2), |f| {
            let s = f.as_scaled(em(f, px));
            (s.ascent(), s.descent())
        })
    }

    /// The glyph for `c` at `px`, made on first use. None: nothing to draw (a character no font has,
    /// one waiting for the fallback, or a full atlas this frame). A space is a zero-size glyph.
    pub fn glyph(&mut self, c: char, px: f32) -> Option<Glyph> {
        let key = (c, px.round().clamp(1.0, 512.0) as u16);
        if let Some(g) = self.cache.get(&key) {
            return *g;
        }
        let font = match self.pick(c) {
            Pick::Font(f) => f,
            Pick::Later => return None, // not cached: the fallback may have it next frame
            Pick::None => {
                self.cache.insert(key, None);
                return None;
            }
        };
        let made = self.make(&font, c, key.1 as f32);
        if !self.full {
            self.cache.insert(key, made);
        }
        made
    }

    /// The pen advance of `c` (spaces included).
    pub fn advance(&mut self, c: char, px: f32) -> f32 {
        if let Some(g) = self.glyph(c, px) {
            return g.advance;
        }
        match self.pick(c) {
            Pick::Font(f) => f.as_scaled(em(&f, px)).h_advance(f.glyph_id(c)),
            _ => px * 0.5,
        }
    }

    fn make(&mut self, font: &FontArc, c: char, px: f32) -> Option<Glyph> {
        let scale = em(font, px);
        let id = font.glyph_id(c);
        let advance = font.as_scaled(scale).h_advance(id);
        let blank = Glyph { x: 0, y: 0, w: 0, h: 0, left: 0, top: 0, advance };
        let Some(outlined) = font.outline_glyph(id.with_scale_and_position(scale, ab_glyph::point(0.0, 0.0))) else {
            return Some(blank); // a space: nothing to draw, but it advances
        };
        let b = outlined.px_bounds();
        let (w, h) = (b.width() as u32, b.height() as u32);
        if w == 0 || h == 0 {
            return Some(blank);
        }
        if w + PAD > ATLAS || h + PAD > ATLAS {
            return None;
        }
        if self.shelf_x + w + PAD > ATLAS {
            self.shelf_y += self.shelf_h + PAD;
            self.shelf_x = 0;
            self.shelf_h = 0;
        }
        if self.shelf_y + h + PAD > ATLAS {
            self.full = true;
            return None;
        }
        let mut data = vec![0u8; (w * h) as usize];
        outlined.draw(|x, y, cover| {
            if x < w && y < h {
                data[(y * w + x) as usize] = (cover.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        });
        let (x, y) = (self.shelf_x, self.shelf_y);
        self.shelf_x += w + PAD;
        self.shelf_h = self.shelf_h.max(h);
        self.pending.push(Upload { x, y, w, h, data });
        Some(Glyph { x, y, w, h, left: b.min.x as i32, top: -b.min.y as i32, advance })
    }

    /// Lay out one line from pen x = 0: each glyph at a whole-pixel pen position, and the width.
    pub fn line(&mut self, s: &str, px: f32) -> (Vec<Placed>, f32) {
        let mut pen = 0.0f32;
        let mut out = Vec::with_capacity(s.len());
        for c in s.chars() {
            if c.is_control() {
                continue;
            }
            let x = pen.round();
            match self.glyph(c, px) {
                Some(g) => {
                    if g.w > 0 {
                        out.push(Placed { x, glyph: g });
                    }
                    pen += g.advance;
                }
                None => pen += self.advance(c, px),
            }
        }
        (out, pen)
    }

    pub fn width(&mut self, s: &str, px: f32) -> f32 {
        s.chars().filter(|c| !c.is_control()).map(|c| self.advance(c, px)).sum()
    }

    /// `s` cut to fit `max` pixels, with an ellipsis when cut ("…", or "...": Jua has no "…").
    pub fn fit(&mut self, s: &str, px: f32, max: f32) -> String {
        if self.width(s, px) <= max {
            return s.to_owned();
        }
        let ellipsis = if self.primary.as_ref().is_some_and(|f| has(f, '…')) { "…" } else { "..." };
        let dots = self.width(ellipsis, px);
        let mut out = String::new();
        let mut w = 0.0;
        for c in s.chars() {
            let a = self.advance(c, px);
            if w + a + dots > max {
                break;
            }
            w += a;
            out.push(c);
        }
        out.trim_end().to_owned() + ellipsis
    }

    /// Break `s` into lines no wider than `max` pixels: at spaces, and between any two Hangul/CJK
    /// characters (Korean wraps by syllable when a word does not fit, like the web's `word-break`).
    pub fn wrap(&mut self, s: &str, px: f32, max: f32) -> Vec<String> {
        let mut lines = Vec::new();
        for para in s.split('\n') {
            let chars: Vec<char> = para.chars().filter(|c| !c.is_control()).collect();
            let mut start = 0;
            while start < chars.len() {
                let mut w = 0.0;
                let mut end = start;
                let mut last_break = None;
                while end < chars.len() {
                    let a = self.advance(chars[end], px);
                    if w + a > max && end > start {
                        break;
                    }
                    w += a;
                    end += 1;
                    if end < chars.len() && (chars[end - 1] == ' ' || is_cjk(chars[end - 1]) && is_cjk(chars[end])) {
                        last_break = Some(end);
                    }
                }
                // a Latin word that did not fit moves whole to the next line (when the line has room before it)
                if end < chars.len() && !(chars[end] == ' ' || is_cjk(chars[end - 1]) && is_cjk(chars[end])) {
                    if let Some(b) = last_break {
                        end = b;
                    }
                }
                lines.push(chars[start..end].iter().collect::<String>().trim_end().to_owned());
                start = end;
                while start < chars.len() && chars[start] == ' ' {
                    start += 1;
                }
            }
            if chars.is_empty() {
                lines.push(String::new());
            }
        }
        lines
    }
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11FF | 0x3000..=0x30FF | 0x3130..=0x318F | 0x4E00..=0x9FFF | 0xAC00..=0xD7A3 | 0xFF00..=0xFFEF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_hangul_syllable_can_be_drawn() {
        let mut t = Text::new();
        // Jua: the 2 350 common syllables (KS X 1001), Latin, digits and the UI punctuation
        let jua_has = |t: &Text, c: char| t.primary.as_ref().is_some_and(|f| has(f, c));
        let syllables: Vec<char> = (0xAC00..=0xD7A3u32).filter_map(char::from_u32).collect();
        assert!(syllables.iter().filter(|&&c| jua_has(&t, c)).count() >= 2350);
        for c in "가나다라 한글 반 선생님 학생 방 만들기 입장 준비".chars().chain('!'..='~') {
            assert!(c == ' ' || c == '`' || jua_has(&t, c), "Jua lacks {c:?}");
        }
        // the rest (a name like 똠 or 햏) comes from the system CJK font, loaded on the first miss
        assert!(!jua_has(&t, '똠'));
        if !t.wait_fallback() {
            eprintln!("no system CJK font on this machine: fallback not checked");
            return;
        }
        // punctuation Jua lacks (the UI uses · and …) comes from the same fallback
        let missing: Vec<char> = syllables.into_iter().chain("·…`".chars()).filter(|&c| !t.drawable(c)).collect();
        assert!(t.glyph('똠', 24.0).is_some_and(|g| g.w > 8 && g.h > 8), "a fallback glyph has pixels");
        assert!(missing.is_empty(), "{} syllables cannot be drawn: {:?}", missing.len(), &missing[..missing.len().min(10)]);
    }

    #[test]
    fn glyphs_are_made_once_and_packed_apart() {
        let mut t = Text::new();
        let a = t.glyph('가', 24.0).unwrap();
        let b = t.glyph('나', 24.0).unwrap();
        assert_eq!(t.glyph('가', 24.0), Some(a), "cached");
        assert_eq!(t.take_uploads().len(), 2);
        assert!(t.take_uploads().is_empty());
        assert!(a.x + a.w < b.x || a.y + a.h < b.y || b.x + b.w < a.x, "{a:?} overlaps {b:?}");
        assert!(a.w > 10 && a.h > 10 && a.top > 0, "{a:?}");
        // a different size is a different glyph
        assert_ne!(t.glyph('가', 40.0).unwrap().w, a.w);
    }

    #[test]
    fn a_full_atlas_refills_instead_of_failing() {
        let mut t = Text::new();
        let mut drawn = 0;
        for (i, c) in (0xAC00..0xAC00 + 4000u32).filter_map(char::from_u32).enumerate() {
            if t.glyph(c, 120.0 + (i % 3) as f32).is_some() {
                drawn += 1;
            }
        }
        assert!(t.full && drawn > 100);
        t.begin_frame();
        assert!(!t.full && t.glyph('가', 24.0).is_some());
    }

    #[test]
    fn layout_measures_fits_and_wraps() {
        let mut t = Text::new();
        let (placed, w) = t.line("방 만들기", 20.0);
        assert_eq!(placed.len(), 4, "the space draws nothing");
        assert!((w - t.width("방 만들기", 20.0)).abs() < 1e-3);
        assert!(placed.windows(2).all(|p| p[1].x > p[0].x) && placed.iter().all(|p| p.x.fract() == 0.0));
        let cut = t.fit("아주아주아주 긴 방 이름입니다", 20.0, 80.0);
        assert!(cut.ends_with("...") && t.width(&cut, 20.0) <= 80.0, "{cut}");
        assert_eq!(t.fit("짧음", 20.0, 200.0), "짧음");
        let lines = t.wrap("재료는 맞아요! 모양을 바꿔 보세요", 20.0, 90.0);
        assert!(lines.len() >= 3 && lines.iter().all(|l| t.width(l, 20.0) <= 90.0 + 0.01), "{lines:?}");
        assert_eq!(lines.concat().replace(' ', ""), "재료는맞아요!모양을바꿔보세요");
        let latin = t.wrap("hello wonderful world", 20.0, 100.0);
        assert!(latin.iter().all(|l| !l.starts_with(' ') && !l.is_empty()), "{latin:?}");
        assert!(latin.contains(&"world".to_string()), "words stay whole: {latin:?}");
    }

    #[test]
    fn odd_input_is_harmless() {
        let mut t = Text::new();
        for s in ["", "\u{0}\u{7}\t", "🦖", "\u{FFFF}", &"가".repeat(500)] {
            let _ = t.line(s, 18.0);
            let _ = t.wrap(s, 18.0, 50.0);
            let _ = t.fit(s, 18.0, 30.0);
        }
        assert!(t.glyph('가', 0.0).is_some() || t.glyph('가', 0.0).is_none());
    }
}
