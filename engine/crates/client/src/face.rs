//! The player's face — the web's faceCanvas.ts: the character texture is the body colour with a
//! face picture over it (the GLB's own texture is exactly that composite for the neutral face), so
//! a face is swapped by composing another picture, and a face animation draws each frame of its
//! sheet into the face's crop. The state machine is FaceCanvas's: `set` a still face, `play` a
//! sequence that ends on a face, a blink every 3–5.4 s while neutral.
//!
//! Pictures are the web's files (compiled in), decoded on a background thread for the character in
//! use (the stills downscaled to the canvas, as the web's createImageBitmap does); until one has
//! arrived the face keeps what it shows. Only the player's own face is live (classmates keep their
//! model's neutral face, which is the GLB's texture).

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use crate::character::Kind;

macro_rules! web {
    ($path:literal) => {
        include_bytes!(concat!("../../../../apps/client/public/models/characters/", $path)).as_slice()
    };
}

const SEQUENCES: &str = include_str!("../../../../apps/client/public/models/characters/face-animations.json");

/// The stills (character.ts FACE_IDS) and the sheets, per character.
const FACES: [&str; 20] = ["neutral", "blink", "smile", "happy", "laugh", "wink", "love", "excited", "smug", "curious", "oh", "worried", "sad", "cry", "angry", "hurt", "dizzy", "tired", "sleep", "dead"];

fn still(kind: Kind, face: &str) -> Option<&'static [u8]> {
    match (kind, face) {
        (Kind::Home, "neutral") => Some(web!("HOME/textures/face-neutral.png")),
        (Kind::Home, "blink") => Some(web!("HOME/textures/face-blink.png")),
        (Kind::Home, "smile") => Some(web!("HOME/textures/face-smile.png")),
        (Kind::Home, "happy") => Some(web!("HOME/textures/face-happy.png")),
        (Kind::Home, "laugh") => Some(web!("HOME/textures/face-laugh.png")),
        (Kind::Home, "wink") => Some(web!("HOME/textures/face-wink.png")),
        (Kind::Home, "love") => Some(web!("HOME/textures/face-love.png")),
        (Kind::Home, "excited") => Some(web!("HOME/textures/face-excited.png")),
        (Kind::Home, "smug") => Some(web!("HOME/textures/face-smug.png")),
        (Kind::Home, "curious") => Some(web!("HOME/textures/face-curious.png")),
        (Kind::Home, "oh") => Some(web!("HOME/textures/face-oh.png")),
        (Kind::Home, "worried") => Some(web!("HOME/textures/face-worried.png")),
        (Kind::Home, "sad") => Some(web!("HOME/textures/face-sad.png")),
        (Kind::Home, "cry") => Some(web!("HOME/textures/face-cry.png")),
        (Kind::Home, "angry") => Some(web!("HOME/textures/face-angry.png")),
        (Kind::Home, "hurt") => Some(web!("HOME/textures/face-hurt.png")),
        (Kind::Home, "dizzy") => Some(web!("HOME/textures/face-dizzy.png")),
        (Kind::Home, "tired") => Some(web!("HOME/textures/face-tired.png")),
        (Kind::Home, "sleep") => Some(web!("HOME/textures/face-sleep.png")),
        (Kind::Home, "dead") => Some(web!("HOME/textures/face-dead.png")),
        (Kind::Tt, "neutral") => Some(web!("TT/textures/face-neutral.png")),
        (Kind::Tt, "blink") => Some(web!("TT/textures/face-blink.png")),
        (Kind::Tt, "smile") => Some(web!("TT/textures/face-smile.png")),
        (Kind::Tt, "happy") => Some(web!("TT/textures/face-happy.png")),
        (Kind::Tt, "laugh") => Some(web!("TT/textures/face-laugh.png")),
        (Kind::Tt, "wink") => Some(web!("TT/textures/face-wink.png")),
        (Kind::Tt, "love") => Some(web!("TT/textures/face-love.png")),
        (Kind::Tt, "excited") => Some(web!("TT/textures/face-excited.png")),
        (Kind::Tt, "smug") => Some(web!("TT/textures/face-smug.png")),
        (Kind::Tt, "curious") => Some(web!("TT/textures/face-curious.png")),
        (Kind::Tt, "oh") => Some(web!("TT/textures/face-oh.png")),
        (Kind::Tt, "worried") => Some(web!("TT/textures/face-worried.png")),
        (Kind::Tt, "sad") => Some(web!("TT/textures/face-sad.png")),
        (Kind::Tt, "cry") => Some(web!("TT/textures/face-cry.png")),
        (Kind::Tt, "angry") => Some(web!("TT/textures/face-angry.png")),
        (Kind::Tt, "hurt") => Some(web!("TT/textures/face-hurt.png")),
        (Kind::Tt, "dizzy") => Some(web!("TT/textures/face-dizzy.png")),
        (Kind::Tt, "tired") => Some(web!("TT/textures/face-tired.png")),
        (Kind::Tt, "sleep") => Some(web!("TT/textures/face-sleep.png")),
        (Kind::Tt, "dead") => Some(web!("TT/textures/face-dead.png")),
        _ => None,
    }
}

fn sheet(kind: Kind, name: &str) -> Option<&'static [u8]> {
    match (kind, name) {
        (Kind::Home, "blink") => Some(web!("HOME/face-sheets/blink.png")),
        (Kind::Home, "smile") => Some(web!("HOME/face-sheets/smile.png")),
        (Kind::Home, "laugh") => Some(web!("HOME/face-sheets/laugh.png")),
        (Kind::Home, "wink") => Some(web!("HOME/face-sheets/wink.png")),
        (Kind::Home, "surprise") => Some(web!("HOME/face-sheets/surprise.png")),
        (Kind::Home, "hurt") => Some(web!("HOME/face-sheets/hurt.png")),
        (Kind::Home, "sleepy") => Some(web!("HOME/face-sheets/sleepy.png")),
        (Kind::Home, "talk") => Some(web!("HOME/face-sheets/talk.png")),
        (Kind::Tt, "blink") => Some(web!("TT/face-sheets/blink.png")),
        (Kind::Tt, "smile") => Some(web!("TT/face-sheets/smile.png")),
        (Kind::Tt, "laugh") => Some(web!("TT/face-sheets/laugh.png")),
        (Kind::Tt, "wink") => Some(web!("TT/face-sheets/wink.png")),
        (Kind::Tt, "surprise") => Some(web!("TT/face-sheets/surprise.png")),
        (Kind::Tt, "hurt") => Some(web!("TT/face-sheets/hurt.png")),
        (Kind::Tt, "sleepy") => Some(web!("TT/face-sheets/sleepy.png")),
        (Kind::Tt, "talk") => Some(web!("TT/face-sheets/talk.png")),
        _ => None,
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub columns: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub crop: [u32; 4],
}

#[derive(Deserialize, Clone)]
pub struct Sequence {
    pub fps: f32,
    pub duration: f32,
    #[serde(rename = "loop")]
    pub looped: bool,
    pub frames: Vec<String>,
    #[serde(default)]
    pub sheets: HashMap<String, Sheet>,
}

#[derive(Deserialize)]
struct Sequences {
    sequences: HashMap<String, Sequence>,
}

pub fn sequences() -> &'static HashMap<String, Sequence> {
    static S: std::sync::OnceLock<HashMap<String, Sequence>> = std::sync::OnceLock::new();
    S.get_or_init(|| serde_json::from_str::<Sequences>(SEQUENCES).map(|s| s.sequences).unwrap_or_default())
}

/// The face canvas's size (faceCanvas.ts: HOME 512², TT 1024 × 512) and body colour.
pub fn canvas(kind: Kind) -> (u32, u32, [u8; 3]) {
    match kind {
        Kind::Home => (512, 512, [0xFF, 0xD1, 0x47]),
        Kind::Tt => (1024, 512, [0xA3, 0x66, 0xEF]),
    }
}

/// A decoded picture (RGBA8): a still at canvas size, or a whole sheet.
pub struct Pic {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

/// Halve (box filter) until the picture is the canvas size (the stills are drawn at 2×).
fn fit(mut p: Pic, w: u32, h: u32) -> Pic {
    while p.w >= w * 2 && p.h >= h * 2 {
        let (nw, nh) = (p.w / 2, p.h / 2);
        let mut out = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh {
            for x in 0..nw {
                for c in 0..4 {
                    let at = |xx: u32, yy: u32| p.rgba[((yy * p.w + xx) * 4 + c) as usize] as u32;
                    let s = at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1);
                    out[((y * nw + x) * 4 + c) as usize] = (s / 4) as u8;
                }
            }
        }
        p = Pic { w: nw, h: nh, rgba: out };
    }
    p
}

fn decode(bytes: &[u8]) -> Option<Pic> {
    crate::character::decode_png(bytes).ok().map(|(w, h, rgba)| Pic { w, h, rgba })
}

/// "Draw `src` (or its region) over `dst` at (x, y)": straight-alpha source-over, 1:1.
#[allow(clippy::too_many_arguments)]
fn over(dst: &mut [u8], dw: u32, src: &Pic, sx: u32, sy: u32, w: u32, h: u32, x: u32, y: u32) {
    for j in 0..h {
        for i in 0..w {
            let s = (((sy + j) * src.w + sx + i) * 4) as usize;
            let d = (((y + j) * dw + x + i) * 4) as usize;
            if s + 3 >= src.rgba.len() || d + 3 >= dst.len() {
                continue;
            }
            let a = src.rgba[s + 3] as u32;
            if a == 0 {
                continue;
            }
            for c in 0..3 {
                dst[d + c] = ((src.rgba[s + c] as u32 * a + dst[d + c] as u32 * (255 - a)) / 255) as u8;
            }
            dst[d + 3] = 255;
        }
    }
}

/// Background decoding of one character's pictures (neutral and blink first).
pub struct Loader {
    rx: Receiver<(Kind, String, Arc<Pic>)>,
    tx: Sender<(Kind, String, Arc<Pic>)>,
    started: Vec<Kind>,
    pub pics: HashMap<(Kind, String), Arc<Pic>>,
}

impl Default for Loader {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        Loader { rx, tx, started: Vec::new(), pics: HashMap::new() }
    }
}

impl Loader {
    /// Start decoding `kind`'s pictures (once).
    pub fn want(&mut self, kind: Kind) {
        if self.started.contains(&kind) {
            return;
        }
        self.started.push(kind);
        let tx = self.tx.clone();
        let _ = std::thread::Builder::new().name("faces".into()).spawn(move || {
            let (w, h, _) = canvas(kind);
            let mut names: Vec<String> = vec!["still:neutral".into(), "sheet:blink".into()];
            names.extend(FACES.iter().map(|f| format!("still:{f}")));
            names.extend(sequences().keys().map(|k| format!("sheet:{k}")));
            let mut done = std::collections::HashSet::new();
            for n in names {
                if !done.insert(n.clone()) {
                    continue;
                }
                let pic = if let Some(f) = n.strip_prefix("still:") { still(kind, f).and_then(decode).map(|p| fit(p, w, h)) } else { sheet(kind, &n[6..]).and_then(decode) };
                if let Some(p) = pic {
                    if tx.send((kind, n, Arc::new(p))).is_err() {
                        return;
                    }
                }
            }
        });
    }

    pub fn poll(&mut self) {
        while let Ok((k, n, p)) = self.rx.try_recv() {
            self.pics.insert((k, n), p);
        }
    }

    fn get(&self, kind: Kind, name: &str) -> Option<&Arc<Pic>> {
        self.pics.get(&(kind, name.to_owned()))
    }
}

/// faceCanvas.ts FaceCanvas: what the face shows and when it changes.
pub struct Face {
    pub kind: Kind,
    base: String,
    blink_in: f32,
    /// (sequence, time, the face it ends on, the frame drawn)
    active: Option<(String, f32, String, Option<usize>)>,
    seed: u32,
    /// The composed texture (RGBA8 at canvas size), and whether it changed since last taken.
    pub rgba: Vec<u8>,
    dirty: bool,
    /// The still under the canvas right now (a sequence draws its frames over it).
    shown: Option<String>,
}

impl Face {
    pub fn new(kind: Kind) -> Face {
        let (w, h, _) = canvas(kind);
        Face { kind, base: "neutral".into(), blink_in: 3.5, active: None, seed: 0x2545_f491, rgba: vec![0; (w * h * 4) as usize], dirty: false, shown: None }
    }

    fn rand(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.seed >> 8) as f32 / (1 << 24) as f32
    }

    /// A still face (it stays; the blink returns only on neutral).
    pub fn set(&mut self, face: &str) {
        self.base = face.to_owned();
        self.active = None;
        self.blink_in = 3.0 + self.rand() * 2.4;
        self.shown = None;
    }

    /// A face animation that ends on `end` (an unknown one is just `end`).
    pub fn play(&mut self, name: &str, end: &str) {
        if sequences().contains_key(name) {
            self.base = end.to_owned();
            self.active = Some((name.to_owned(), 0.0, end.to_owned(), None));
            self.shown = None;
        } else {
            self.set(end);
        }
    }

    /// The still (or sequence) currently wanted.
    #[cfg(test)]
    pub fn base(&self) -> &str {
        &self.base
    }

    fn compose_still(&mut self, loader: &Loader, face: &str) -> bool {
        let Some(p) = loader.get(self.kind, &format!("still:{face}")) else { return false };
        let (w, _h, col) = canvas(self.kind);
        for px in self.rgba.as_chunks_mut::<4>().0 {
            *px = [col[0], col[1], col[2], 255];
        }
        let p = p.clone();
        over(&mut self.rgba, w, &p, 0, 0, p.w, p.h, 0, 0);
        self.shown = Some(face.to_owned());
        self.dirty = true;
        true
    }

    /// FaceCanvas.update: advance the blink and the sequence, composing what changed.
    pub fn update(&mut self, loader: &Loader, dt: f32) {
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        match self.active.clone() {
            None => {
                if self.shown.as_deref() != Some(self.base.as_str()) {
                    let base = self.base.clone();
                    if !self.compose_still(loader, &base) && base != "neutral" && self.shown.is_none() {
                        self.compose_still(loader, "neutral");
                    }
                }
                if self.base == "neutral" {
                    self.blink_in -= dt;
                    if self.blink_in <= 0.0 {
                        self.play("blink", "neutral");
                    }
                }
            }
            Some((name, time, end, drawn)) => {
                let Some(seq) = sequences().get(&name) else {
                    self.set(&end);
                    return;
                };
                let Some(sheet) = seq.sheets.get(match self.kind {
                    Kind::Home => "HOME",
                    Kind::Tt => "TT",
                }) else {
                    self.set(&end);
                    return;
                };
                let Some(pic) = loader.get(self.kind, &format!("sheet:{name}")).cloned() else { return };
                // a sequence draws over the neutral face (FaceCanvas.play)
                if self.shown.as_deref() != Some("neutral") && !self.compose_still(loader, "neutral") {
                    return;
                }
                let mut t = time + if drawn.is_some() { dt } else { 0.0 };
                if t >= seq.duration {
                    if seq.looped {
                        t %= seq.duration;
                    } else {
                        self.set(&end);
                        return;
                    }
                }
                let frame = ((t * seq.fps) as usize).min(seq.frames.len().saturating_sub(1));
                if drawn != Some(frame) {
                    let (w, _, _) = canvas(self.kind);
                    let [x, y, cw, ch] = sheet.crop;
                    let (fx, fy) = ((frame as u32 % sheet.columns) * sheet.frame_width, (frame as u32 / sheet.columns) * sheet.frame_height);
                    over(&mut self.rgba, w, &pic, fx, fy, cw.min(sheet.frame_width), ch.min(sheet.frame_height), x, y);
                    self.dirty = true;
                }
                self.active = Some((name, t, end, Some(frame)));
            }
        }
    }

    /// Upload again on the next take (a new GPU device has none of it).
    pub fn mark_dirty(&mut self) {
        self.dirty = self.shown.is_some();
    }

    /// The texture when it changed since last asked (to upload).
    pub fn take(&mut self) -> Option<&[u8]> {
        std::mem::take(&mut self.dirty).then_some(self.rgba.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_face_and_sheet_ships_and_decodes() {
        for kind in [Kind::Home, Kind::Tt] {
            let (w, h, _) = canvas(kind);
            for f in FACES {
                let p = fit(decode(still(kind, f).unwrap_or_else(|| panic!("{f}"))).unwrap(), w, h);
                assert_eq!((p.w, p.h), (w, h), "{f} at canvas size");
            }
            for (name, seq) in sequences() {
                let sh = &seq.sheets[match kind {
                    Kind::Home => "HOME",
                    Kind::Tt => "TT",
                }];
                let p = decode(sheet(kind, name).unwrap()).unwrap();
                let rows = seq.frames.len().div_ceil(sh.columns as usize) as u32;
                assert!(p.w >= sh.columns * sh.frame_width && p.h >= rows * sh.frame_height, "{name}: the sheet holds its frames");
                assert!(sh.crop[0] + sh.crop[2] <= w && sh.crop[1] + sh.crop[3] <= h, "{name}: the crop is on the canvas");
            }
        }
        assert_eq!(sequences().len(), 8);
    }

    #[test]
    fn the_face_blinks_plays_and_settles_like_face_canvas() {
        let mut loader = Loader::default();
        loader.want(Kind::Home);
        let t0 = std::time::Instant::now();
        while loader.pics.len() < 28 && t0.elapsed().as_secs() < 30 {
            loader.poll();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let mut f = Face::new(Kind::Home);
        f.update(&loader, 0.016);
        let neutral = f.take().expect("the neutral face is composed").to_vec();
        // an idle face blinks within 5.4 s, and comes back to neutral
        let mut changed = false;
        for _ in 0..(6.0 / 0.016) as usize {
            f.update(&loader, 0.016);
            if f.take().is_some() {
                changed = true;
            }
        }
        assert!(changed, "it blinked");
        // a smile plays, then settles on its end face
        f.play("smile", "happy");
        for _ in 0..(1.5 / 0.016) as usize {
            f.update(&loader, 0.016);
        }
        assert_eq!(f.base(), "happy");
        f.take();
        assert_ne!(f.rgba, neutral, "a happy face is not the neutral one");
        f.set("neutral");
        f.update(&loader, 0.016);
        assert_eq!(f.take().unwrap(), neutral.as_slice(), "and neutral is the GLB's own composite again");
    }
}
