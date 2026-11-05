//! The menu art: the web's own files (`apps/client/public`), compiled in and decoded on a background
//! thread at start, so the app's lobby is the web's hub, not a lookalike. One source of truth: a
//! new background or icon on the web is a new picture in the app with no copy to keep in step.
//!
//! Frames are drawn as 9-slices with the web's numbers (`border-image: url(…) <slice> / <width> /
//! <outset> round`, index.html): [`Frame`] carries them. Card pictures are halved on decode: the
//! app shows them at ≤ 320 px wide, and full size would cost 11 MB of video memory for nothing.

use std::sync::mpsc::{self, Receiver};

macro_rules! web {
    ($path:literal) => {
        include_bytes!(concat!("../../../../apps/client/public/", $path))
    };
}

/// Every menu picture. The discriminant indexes [`ALL`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Art {
    Background,
    Logo,
    CardEducation,
    CardGames,
    CardTeacher,
    CardStudent,
    CardSolo,
    CardCraft,
    IconHome,
    IconCreate,
    IconFriends,
    IconSettings,
    IconGrad,
    IconCrown,
    IconParty,
    IconLock,
    IconBell,
    // the in-game HUD pack (assets/ui-game)
    Slot,
    SlotSelected,
    BtnRound,
    BtnRoundPressed,
    StickBase,
    StickKnob,
    GlyphDig,
    GlyphPlace,
    GlyphJump,
    GlyphChat,
    GlyphExit,
    ProgressFrame,
    NamePlate,
    ToastFrame,
    Crack1,
    Crack2,
    Crack3,
    Crack4,
    Crack5,
    Crack6,
    Poof1,
    Poof2,
    Poof3,
    Poof4,
    Poof5,
    Poof6,
    GlyphPaw,
    PetDog,
    PetCat,
    PetElephant,
    PetGiraffe,
    PetPanda,
    NavHome,
    NavEdu,
    NavPlay,
    NavFriends,
    NavSettings,
    NavMenu,
    BtnStart,
    ItemPickaxe,
    GlyphBag,
    PieceCube,
    PieceSlope,
    PieceCorner,
    PieceRound,
    PieceSlab,
    PieceStairs,
    GlyphTurn,
    GlyphEmote,
}

pub const ALL: [Art; 66] = [
    Art::Background,
    Art::Logo,
    Art::CardEducation,
    Art::CardGames,
    Art::CardTeacher,
    Art::CardStudent,
    Art::CardSolo,
    Art::CardCraft,
    Art::IconHome,
    Art::IconCreate,
    Art::IconFriends,
    Art::IconSettings,
    Art::IconGrad,
    Art::IconCrown,
    Art::IconParty,
    Art::IconLock,
    Art::IconBell,
    Art::Slot,
    Art::SlotSelected,
    Art::BtnRound,
    Art::BtnRoundPressed,
    Art::StickBase,
    Art::StickKnob,
    Art::GlyphDig,
    Art::GlyphPlace,
    Art::GlyphJump,
    Art::GlyphChat,
    Art::GlyphExit,
    Art::ProgressFrame,
    Art::NamePlate,
    Art::ToastFrame,
    Art::Crack1,
    Art::Crack2,
    Art::Crack3,
    Art::Crack4,
    Art::Crack5,
    Art::Crack6,
    Art::Poof1,
    Art::Poof2,
    Art::Poof3,
    Art::Poof4,
    Art::Poof5,
    Art::Poof6,
    Art::GlyphPaw,
    Art::PetDog,
    Art::PetCat,
    Art::PetElephant,
    Art::PetGiraffe,
    Art::PetPanda,
    Art::NavHome,
    Art::NavEdu,
    Art::NavPlay,
    Art::NavFriends,
    Art::NavSettings,
    Art::NavMenu,
    Art::BtnStart,
    Art::ItemPickaxe,
    Art::GlyphBag,
    Art::PieceCube,
    Art::PieceSlope,
    Art::PieceCorner,
    Art::PieceRound,
    Art::PieceSlab,
    Art::PieceStairs,
    Art::GlyphTurn,
    Art::GlyphEmote,
];

impl Art {
    pub fn index(self) -> usize {
        self as usize
    }

    fn source(self) -> (&'static [u8], u32) {
        // (file, downscale factor)
        match self {
            Art::Background => (web!("backgrounds/craftyap-sunny-village-desktop.webp"), 1),
            Art::Logo => (web!("craftyap-logo.webp"), 1),
            Art::CardEducation => (web!("home/education.webp"), 2),
            Art::CardGames => (web!("home/games.webp"), 2),
            Art::CardTeacher => (web!("home/teacher.webp"), 2),
            Art::CardStudent => (web!("home/student.webp"), 2),
            Art::CardSolo => (web!("home/solo.webp"), 2),
            Art::CardCraft => (web!("home/craft.webp"), 2),
            Art::IconHome => (web!("ui/hub/icon-home.webp"), 1),
            Art::IconCreate => (web!("ui/hub/icon-create.webp"), 1),
            Art::IconFriends => (web!("ui/hub/icon-friends.webp"), 1),
            Art::IconSettings => (web!("ui/hub/icon-settings.webp"), 1),
            Art::IconGrad => (web!("ui/hub/icon-grad.webp"), 1),
            Art::IconCrown => (web!("ui/hub/icon-crown.webp"), 1),
            Art::IconParty => (web!("ui/hub/icon-party.webp"), 1),
            Art::IconLock => (web!("ui/hub/icon-lock.webp"), 1),
            Art::IconBell => (web!("ui/hub/icon-bell.webp"), 1),
            Art::Slot => (web!("ui/game/slot.webp"), 1),
            Art::SlotSelected => (web!("ui/game/slot-selected.webp"), 1),
            Art::BtnRound => (web!("ui/game/btn-round.webp"), 1),
            Art::BtnRoundPressed => (web!("ui/game/btn-round-pressed.webp"), 1),
            Art::StickBase => (web!("ui/game/stick-base.webp"), 1),
            Art::StickKnob => (web!("ui/game/stick-knob.webp"), 1),
            Art::GlyphDig => (web!("ui/game/glyph-dig.webp"), 1),
            Art::GlyphPlace => (web!("ui/game/glyph-place.webp"), 1),
            Art::GlyphJump => (web!("ui/game/glyph-jump.webp"), 1),
            Art::GlyphChat => (web!("ui/game/glyph-chat.webp"), 1),
            Art::GlyphExit => (web!("ui/game/glyph-exit.webp"), 1),
            Art::ProgressFrame => (web!("ui/game/progress-frame.webp"), 1),
            Art::NamePlate => (web!("ui/game/name-plate.webp"), 1),
            Art::ToastFrame => (web!("ui/game/toast-frame.webp"), 1),
            Art::Crack1 => (web!("ui/game/fx-crack-1.webp"), 1),
            Art::Crack2 => (web!("ui/game/fx-crack-2.webp"), 1),
            Art::Crack3 => (web!("ui/game/fx-crack-3.webp"), 1),
            Art::Crack4 => (web!("ui/game/fx-crack-4.webp"), 1),
            Art::Crack5 => (web!("ui/game/fx-crack-5.webp"), 1),
            Art::Crack6 => (web!("ui/game/fx-crack-6.webp"), 1),
            Art::Poof1 => (web!("ui/game/fx-poof-1.webp"), 1),
            Art::Poof2 => (web!("ui/game/fx-poof-2.webp"), 1),
            Art::Poof3 => (web!("ui/game/fx-poof-3.webp"), 1),
            Art::Poof4 => (web!("ui/game/fx-poof-4.webp"), 1),
            Art::Poof5 => (web!("ui/game/fx-poof-5.webp"), 1),
            Art::Poof6 => (web!("ui/game/fx-poof-6.webp"), 1),
            Art::GlyphPaw => (web!("ui/game/glyph-paw.webp"), 1),
            Art::PetDog => (web!("ui/game/pet-dog.webp"), 1),
            Art::PetCat => (web!("ui/game/pet-cat.webp"), 1),
            Art::PetElephant => (web!("ui/game/pet-elephant.webp"), 1),
            Art::PetGiraffe => (web!("ui/game/pet-giraffe.webp"), 1),
            Art::PetPanda => (web!("ui/game/pet-panda.webp"), 1),
            Art::NavHome => (web!("ui/game/nav-home.webp"), 1),
            Art::NavEdu => (web!("ui/game/nav-edu.webp"), 1),
            Art::NavPlay => (web!("ui/game/nav-play.webp"), 1),
            Art::NavFriends => (web!("ui/game/nav-friends.webp"), 1),
            Art::NavSettings => (web!("ui/game/nav-settings.webp"), 1),
            Art::NavMenu => (web!("ui/game/nav-menu.webp"), 1),
            Art::BtnStart => (web!("ui/game/btn-start.webp"), 1),
            Art::ItemPickaxe => (web!("models/items/tools/pickaxe-basic/icon.png"), 4),
            Art::GlyphBag => (web!("ui/game/glyph-bag.webp"), 1),
            Art::PieceCube => (web!("ui/game/piece-cube.webp"), 1),
            Art::PieceSlope => (web!("ui/game/piece-slope.webp"), 1),
            Art::PieceCorner => (web!("ui/game/piece-corner.webp"), 1),
            Art::PieceRound => (web!("ui/game/piece-round.webp"), 1),
            Art::PieceSlab => (web!("ui/game/piece-slab.webp"), 1),
            Art::PieceStairs => (web!("ui/game/piece-stairs.webp"), 1),
            Art::GlyphTurn => (web!("ui/game/glyph-turn.webp"), 1),
            Art::GlyphEmote => (web!("ui/game/glyph-emote.webp"), 1),
        }
    }
}

/// A 9-slice frame: source slice (px of the picture: top, right, bottom, left), the rim's drawn
/// width (dp, same order) and how far it reaches outside the box (dp) — the web's border-image.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub art: Art,
    pub slice: [f32; 4],
    pub width: [f32; 4],
    pub outset: [f32; 4],
    /// `fill`: draw the middle too.
    pub fill: bool,
}

/// The web's frames (index.html, hub styles), number for number.
pub mod frames {
    use super::{Art, Frame};
    /// The in-game plates (assets/ui-game, lineless; slices measured on the built 640 px pictures).
    /// A pill: the rounded ends (with their studs) are the side slices.
    pub const NAME_PLATE: Frame = Frame { art: Art::NamePlate, slice: [30.0, 84.0, 30.0, 84.0], width: [4.0, 12.0, 4.0, 12.0], outset: [0.0; 4], fill: true };
    /// The bar's rim around a transparent slot: the outset puts the slot on the box (the fill).
    pub const PROGRESS: Frame = Frame { art: Art::ProgressFrame, slice: [44.0, 34.0, 30.0, 34.0], width: [9.0, 7.0, 6.0, 7.0], outset: [9.0, 7.0, 6.0, 7.0], fill: false };
}

include!(concat!(env!("OUT_DIR"), "/icons_gen.rs"));

/// Block icons come after the menu pictures in the slot numbering.
pub const ICON_BASE: usize = ALL.len();
/// How many picture slots there are.
pub const SLOTS: usize = ALL.len() + ICONS.len();

/// The slot of a block's icon (by its texture name), if the web has one.
pub fn icon_slot(texture: &str) -> Option<usize> {
    ICONS.iter().position(|(name, _)| *name == texture).map(|i| ICON_BASE + i)
}

/// One decoded picture (RGBA8, straight alpha, sRGB).
pub struct Image {
    /// Its picture slot: a menu `Art` (its index) or a block icon (`ICON_BASE` + its place in ICONS).
    pub slot: usize,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    /// The mip chain below level 0 (each half the size, box-filtered), so an icon drawn at a third
    /// of its size does not shimmer. Made on the art thread, never at upload.
    pub fn mips(&self) -> Vec<(u32, u32, Vec<u8>)> {
        let mut out = Vec::new();
        let (mut w, mut h, mut px) = (self.width, self.height, self.rgba.clone());
        while w > 1 || h > 1 {
            let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
            let mut next = vec![0u8; (nw * nh * 4) as usize];
            for y in 0..nh {
                for x in 0..nw {
                    for c in 0..4 {
                        let at = |xx: u32, yy: u32| px[((yy.min(h - 1) * w + xx.min(w - 1)) * 4 + c) as usize] as u32;
                        let sum = at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1);
                        next[((y * nw + x) * 4 + c) as usize] = ((sum + 2) / 4) as u8;
                    }
                }
            }
            out.push((nw, nh, next.clone()));
            (w, h, px) = (nw, nh, next);
        }
        out
    }
}

fn decode(art: Art) -> Result<Image, String> {
    let (bytes, down) = art.source();
    decode_bytes(art.index(), bytes, down)
}

fn decode_bytes(slot: usize, bytes: &[u8], down: u32) -> Result<Image, String> {
    // the web's pictures are WebP; an item icon (the pickaxe's) is a PNG
    let (w, h, rgba) = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        crate::character::decode_png(bytes)?
    } else {
        let mut d = image_webp::WebPDecoder::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let (w, h) = d.dimensions();
        let mut raw = vec![0u8; d.output_buffer_size().ok_or("image too large")?];
        d.read_image(&mut raw).map_err(|e| e.to_string())?;
        let rgba: Vec<u8> = if d.has_alpha() { raw } else { raw.as_chunks::<3>().0.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect() };
        (w, h, rgba)
    };
    if down <= 1 {
        return Ok(Image { slot, width: w, height: h, rgba });
    }
    // box filter: each output texel is the mean of a down × down block
    let (ow, oh) = (w / down, h / down);
    let mut out = vec![0u8; (ow * oh * 4) as usize];
    let n = down * down;
    for y in 0..oh {
        for x in 0..ow {
            let mut acc = [0u32; 4];
            for dy in 0..down {
                for dx in 0..down {
                    let i = (((y * down + dy) * w + x * down + dx) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += rgba[i + c] as u32;
                    }
                }
            }
            let o = ((y * ow + x) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (acc[c] / n) as u8;
            }
        }
    }
    Ok(Image { slot, width: ow, height: oh, rgba: out })
}

/// Decodes every picture on a background thread; the renderer takes them as they arrive.
pub struct ArtLoader {
    rx: Option<Receiver<Image>>,
}

impl ArtLoader {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel();
        let started = std::thread::Builder::new().name("menu-art".into()).spawn(move || {
            let t = std::time::Instant::now();
            // the loading screen's own pictures first
            for art in ALL {
                match decode(art) {
                    Ok(img) => {
                        if tx.send(img).is_err() {
                            return;
                        }
                    }
                    Err(e) => log::error!("menu art {art:?}: {e} (drawn as nothing)"),
                }
            }
            log::info!("menu art decoded in {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
            // then the block icons (hotbar), halved: they are drawn at most ~60 px
            for (i, (name, bytes)) in ICONS.iter().enumerate() {
                match decode_bytes(ICON_BASE + i, bytes, 2) {
                    Ok(img) => {
                        if tx.send(img).is_err() {
                            return;
                        }
                    }
                    Err(e) => log::warn!("block icon {name}: {e}"),
                }
            }
        });
        if let Err(e) = started {
            log::error!("cannot start the menu art thread: {e}");
        }
        Self { rx: Some(rx) }
    }

    /// Pictures decoded since the last call.
    pub fn take(&mut self) -> Vec<Image> {
        let Some(rx) = &self.rx else { return Vec::new() };
        let mut out = Vec::new();
        loop {
            match rx.try_recv() {
                Ok(img) => out.push(img),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.rx = None;
                    break;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_picture_decodes_and_the_list_is_complete() {
        for (i, art) in ALL.iter().enumerate() {
            assert_eq!(art.index(), i, "ALL is in declaration order");
            let img = decode(*art).unwrap_or_else(|e| panic!("{art:?}: {e}"));
            assert_eq!(img.rgba.len(), (img.width * img.height * 4) as usize);
            assert!(img.width >= 64 && img.height >= 64, "{art:?} {}x{}", img.width, img.height);
        }
        assert_eq!(decode(Art::CardCraft).unwrap().width, 320, "cards are halved");
    }

    #[test]
    fn frames_slice_inside_their_pictures() {
        use frames::*;
        for f in [NAME_PLATE, PROGRESS] {
            let img = decode(f.art).unwrap();
            assert!(f.slice[1] + f.slice[3] < img.width as f32 && f.slice[0] + f.slice[2] < img.height as f32, "{:?}", f.art);
        }
    }
}
