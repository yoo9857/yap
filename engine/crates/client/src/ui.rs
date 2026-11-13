#![allow(clippy::possible_missing_else)] // (the polygon clipper is written on one line: its `}if` is two statements)
//! The screen overlay (ui.wgsl draws it): touch controls and the crosshair, in the web's brick
//! look (gameMenu.css): white faces, a thick ink outline (#1f1f1f), and an ink "lift" under
//! buttons that goes away when pressed, so a press reads as pushing the brick down.
//!
//! Shapes are laid out in dp and painted in physical pixels; everything is a signed distance
//! field, so it stays crisp on any screen density.

use crate::input::{TouchUi, DIG_RADIUS, JUMP_RADIUS, PLACE_RADIUS, STICK_RADIUS};
use crate::art::{Art, Frame};
use crate::text::{Glyph, Text};
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug, PartialEq)]
pub struct UiVertex {
    pub ndc: [f32; 2],
    pub local: [f32; 2],
    pub shape: [f32; 4],
    pub color: [u8; 4],
}

pub const UI_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Unorm8x4];

/// gameMenu.css --brick-ink.
const INK: [u8; 3] = [0x1f, 0x1f, 0x1f];
const WHITE: [u8; 3] = [0xff, 0xff, 0xff];
/// The press depth of a brick button (gameMenu.css --brick-lift: 4px).
const LIFT: f32 = 4.0;
/// The crack stages and the landing puff (assets/ui-game sprite sheets, sliced by its build).
const CRACK: [Art; 6] = [Art::Crack1, Art::Crack2, Art::Crack3, Art::Crack4, Art::Crack5, Art::Crack6];
const POOF: [Art; 6] = [Art::Poof1, Art::Poof2, Art::Poof3, Art::Poof4, Art::Poof5, Art::Poof6];
/// How long a puff plays (six frames).
pub const POOF_SECONDS: f32 = 0.36;
/// The building pieces' icons, in pieces.ts order.
const PIECE_ICONS: [Art; 6] = [Art::PieceCube, Art::PieceSlope, Art::PieceCorner, Art::PieceRound, Art::PieceSlab, Art::PieceStairs];
/// The pets' heads, in adoption order (creatureRig.ts PET_SPECIES).
const PETS: [Art; 5] = [Art::PetDog, Art::PetCat, Art::PetElephant, Art::PetGiraffe, Art::PetPanda];

/// The rest of the web's palette (bag.css --bag-*, gameMenu.css).
const PAPER: [u8; 3] = [0xff, 0xfd, 0xf6];
const YELLOW: [u8; 3] = [0xff, 0xd2, 0x1c];
const GREEN: [u8; 3] = [0x4c, 0xc3, 0x5a];
const DISABLED: [u8; 3] = [0xe7, 0xe2, 0xd3];
const MUTED: [u8; 3] = [0x6b, 0x6f, 0x64];

/// A rectangle in dp (top-left + size): layout and hit-testing.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    Left,
    Center,
    Right,
}

/// How a label is drawn: size (dp), colour (sRGB + alpha) and what its x means.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextStyle {
    pub size: f32,
    pub color: [u8; 4],
    pub align: Align,
}

impl TextStyle {
    pub fn new(size: f32, color: [u8; 4], align: Align) -> Self {
        Self { size, color, align }
    }
}

/// Button faces: yellow (the main action, like the web's Play), green (go / ready), white, red.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ButtonStyle {
    Primary,
    Go,
    Plain,
}

/// The height of one text line at `size` dp, in dp.
pub fn line_height(t: &Text, size: f32, scale: f32) -> f32 {
    let (a, d) = t.line_metrics(size * scale);
    (a - d) / scale
}

/// The END of `s` that fits `max` px: a field shows what is being typed, not its start.
fn tail_fit(t: &mut Text, s: &str, px: f32, max: f32) -> String {
    if t.width(s, px) <= max {
        return s.to_owned();
    }
    let mut out: Vec<char> = Vec::new();
    let mut w = 0.0;
    for c in s.chars().rev() {
        let a = t.advance(c, px);
        if w + a > max {
            break;
        }
        w += a;
        out.push(c);
    }
    out.into_iter().rev().collect()
}

fn rgba(c: [u8; 3], a: f32) -> [u8; 4] {
    [c[0], c[1], c[2], (a.clamp(0.0, 1.0) * 255.0).round() as u8]
}

/// Collects shapes for one frame.
pub struct Painter {
    pub vertices: Vec<UiVertex>,
    /// Runs of vertices by the picture they sample: (first vertex, Art index). Shapes that sample
    /// nothing join whatever run is open, so a screen costs one draw per picture change.
    pub segments: Vec<(u32, Option<usize>)>,
    /// Size of each picture that is on the GPU (by Art index); a picture not there yet is skipped.
    art: Vec<Option<(u32, u32)>>,
    size: (f32, f32),
    scale: f32,
    /// Drawing a phone's HUD (no key numbers on the hotbar).
    pub touch_hud: bool,
}

impl Painter {
    /// `size`: the surface in physical pixels; `scale`: physical pixels per dp.
    pub fn new(size: (u32, u32), scale: f64) -> Self {
        Self { vertices: Vec::new(), segments: Vec::new(), art: Vec::new(), size: (size.0.max(1) as f32, size.1.max(1) as f32), scale: scale as f32, touch_hud: false }
    }

    /// The pictures this frame can draw (their sizes, by Art index).
    pub fn with_art(mut self, sizes: &[Option<(u32, u32)>]) -> Self {
        self.art = sizes.to_vec();
        self
    }

    /// The surface in physical pixels.
    pub fn size_px(&self) -> (f32, f32) {
        self.size
    }

    /// The screen in dp.
    pub fn screen(&self) -> (f32, f32) {
        (self.size.0 / self.scale, self.size.1 / self.scale)
    }

    pub fn art_size(&self, art: Art) -> Option<(f32, f32)> {
        self.slot_size(art.index())
    }

    pub fn slot_size(&self, slot: usize) -> Option<(f32, f32)> {
        self.art.get(slot).copied().flatten().map(|(w, h)| (w as f32, h as f32))
    }

    /// A part of a picture: dp rectangle `r`, uv corners `uv` = [u0, v0, u1, v1], tinted.
    pub fn image_uv(&mut self, art: Art, r: Rect, uv: [f32; 4], tint: [u8; 4]) {
        self.slot_uv(art.index(), r, uv, tint);
    }

    /// A whole picture slot (a block icon) over `r`.
    pub fn slot_image(&mut self, slot: usize, r: Rect, tint: [u8; 4]) {
        self.slot_uv(slot, r, [0.0, 0.0, 1.0, 1.0], tint);
    }

    pub fn slot_uv(&mut self, slot: usize, r: Rect, uv: [f32; 4], tint: [u8; 4]) {
        if self.slot_size(slot).is_none() || r.w <= 0.0 || r.h <= 0.0 {
            return;
        }
        let run = Some(slot);
        if self.segments.last().map(|s| s.1) != Some(run) {
            self.segments.push((self.vertices.len() as u32, run));
        }
        let s = self.scale;
        let (x0, y0, x1, y1) = (r.x * s, r.y * s, (r.x + r.w) * s, (r.y + r.h) * s);
        let shape = [5.0, 0.0, 0.0, 0.0];
        let v = |x: f32, y: f32, u: f32, vv: f32| UiVertex { ndc: [x / self.size.0 * 2.0 - 1.0, 1.0 - y / self.size.1 * 2.0], local: [u, vv], shape, color: tint };
        let (a, b, c, d) = (v(x0, y0, uv[0], uv[1]), v(x1, y0, uv[2], uv[1]), v(x1, y1, uv[2], uv[3]), v(x0, y1, uv[0], uv[3]));
        self.vertices.extend_from_slice(&[a, b, c, a, c, d]);
    }

    /// A whole picture stretched over `r`.
    pub fn image(&mut self, art: Art, r: Rect, tint: [u8; 4]) {
        self.image_uv(art, r, [0.0, 0.0, 1.0, 1.0], tint);
    }

    /// A picture filling `r` and cropped to it (CSS `object-fit: cover`), centred.
    pub fn cover(&mut self, art: Art, r: Rect, tint: [u8; 4]) {
        let Some((w, h)) = self.art_size(art) else { return };
        let (pic, boxr) = (w / h, r.w / r.h.max(1e-3));
        let uv = if pic > boxr {
            let k = boxr / pic;
            [(1.0 - k) / 2.0, 0.0, (1.0 + k) / 2.0, 1.0]
        } else {
            let k = pic / boxr;
            [0.0, (1.0 - k) / 2.0, 1.0, (1.0 + k) / 2.0]
        };
        self.image_uv(art, r, uv, tint);
    }

    /// A 9-slice frame around `r` with the web's border-image numbers (art::Frame): corners at
    /// their drawn width, edges tiled a whole number of times (`round`), the middle stretched.
    pub fn nine(&mut self, f: Frame, r: Rect, tint: [u8; 4]) {
        let Some((iw, ih)) = self.art_size(f.art) else { return };
        let [st, sr, sb, sl] = f.slice;
        let [wt, wr, wb, wl] = f.width;
        let o = Rect::new(r.x - f.outset[3], r.y - f.outset[0], r.w + f.outset[1] + f.outset[3], r.h + f.outset[0] + f.outset[2]);
        // rims never overlap: scale them down together on a box smaller than both
        let k = (o.w / (wl + wr)).min(o.h / (wt + wb)).min(1.0);
        let (wt, wr, wb, wl) = (wt * k, wr * k, wb * k, wl * k);
        let (u0, u1, v0, v1) = (sl / iw, 1.0 - sr / iw, st / ih, 1.0 - sb / ih);
        let (x0, x1, x2) = (o.x, o.x + wl, o.x + o.w - wr);
        let (y0, y1, y2) = (o.y, o.y + wt, o.y + o.h - wb);
        // corners
        self.image_uv(f.art, Rect::new(x0, y0, wl, wt), [0.0, 0.0, u0, v0], tint);
        self.image_uv(f.art, Rect::new(x2, y0, wr, wt), [u1, 0.0, 1.0, v0], tint);
        self.image_uv(f.art, Rect::new(x0, y2, wl, wb), [0.0, v1, u0, 1.0], tint);
        self.image_uv(f.art, Rect::new(x2, y2, wr, wb), [u1, v1, 1.0, 1.0], tint);
        // edges, `round`: the slice's natural length at the drawn width, a whole number of times
        let tiles = |len: f32, natural: f32| ((len / natural.max(1e-3)).round().max(1.0)) as usize;
        let (mid_w, mid_h) = (x2 - x1, y2 - y1);
        let n = tiles(mid_w, (iw - sl - sr) * wt / st.max(1e-3));
        for i in 0..n {
            let (x, w) = (x1 + mid_w * i as f32 / n as f32, mid_w / n as f32);
            self.image_uv(f.art, Rect::new(x, y0, w, wt), [u0, 0.0, u1, v0], tint);
        }
        let n = tiles(mid_w, (iw - sl - sr) * wb / sb.max(1e-3));
        for i in 0..n {
            let (x, w) = (x1 + mid_w * i as f32 / n as f32, mid_w / n as f32);
            self.image_uv(f.art, Rect::new(x, y2, w, wb), [u0, v1, u1, 1.0], tint);
        }
        let n = tiles(mid_h, (ih - st - sb) * wl / sl.max(1e-3));
        for i in 0..n {
            let (y, h) = (y1 + mid_h * i as f32 / n as f32, mid_h / n as f32);
            self.image_uv(f.art, Rect::new(x0, y, wl, h), [0.0, v0, u0, v1], tint);
        }
        let n = tiles(mid_h, (ih - st - sb) * wr / sr.max(1e-3));
        for i in 0..n {
            let (y, h) = (y1 + mid_h * i as f32 / n as f32, mid_h / n as f32);
            self.image_uv(f.art, Rect::new(x2, y, wr, h), [u1, v0, 1.0, v1], tint);
        }
        if f.fill {
            self.image_uv(f.art, Rect::new(x1, y1, mid_w, mid_h), [u0, v0, u1, v1], tint);
        }
    }

    /// One shape: a quad around `(x, y)` (dp) reaching `reach` dp, every size in dp.
    fn quad(&mut self, x: f32, y: f32, reach: [f32; 4], shape: [f32; 4], color: [u8; 4]) {
        let s = self.scale;
        let (cx, cy) = (x * s, y * s);
        // reach: left, top, right, bottom, plus a pixel for the anti-aliasing
        let (l, t, r, b) = (reach[0] * s + 2.0, reach[1] * s + 2.0, reach[2] * s + 2.0, reach[3] * s + 2.0);
        let shape = [shape[0], shape[1] * s, shape[2] * s, shape[3] * s];
        let v = |px: f32, py: f32| UiVertex { ndc: [(cx + px) / self.size.0 * 2.0 - 1.0, 1.0 - (cy + py) / self.size.1 * 2.0], local: [px, py], shape, color };
        let (a, b2, c, d) = (v(-l, -t), v(r, -t), v(r, b), v(-l, b));
        self.vertices.extend_from_slice(&[a, b2, c, a, c, d]);
    }

    /// An opaque projected mesh triangle in dp; it uses the existing plain shape pipeline.
    pub fn triangle(&mut self,points:[[f32;2];3],color:[u8;4]){
        for [x,y] in points{self.vertices.push(UiVertex{ndc:[x*self.scale/self.size.0*2.-1.,1.-y*self.scale/self.size.1*2.],local:[0.,0.],shape:[3.,2.,2.,0.],color});}
    }

    /// Clip a projected preview triangle to its card before emitting it.
    pub fn triangle_in(&mut self,rect:Rect,points:[[f32;2];3],color:[u8;4]){
        let mut polygon=points.to_vec();
        for(axis,edge,greater)in[(0,rect.x,true),(0,rect.x+rect.w,false),(1,rect.y,true),(1,rect.y+rect.h,false)]{
            let input=std::mem::take(&mut polygon);if input.is_empty(){return;}
            let mut before=*input.last().expect("polygon");let inside=|p:[f32;2]|if greater{p[axis]>=edge}else{p[axis]<=edge};
            for point in input{let(a,b)=(inside(before),inside(point));if a!=b{let t=(edge-before[axis])/(point[axis]-before[axis]);polygon.push([before[0]+(point[0]-before[0])*t,before[1]+(point[1]-before[1])*t]);}if b{polygon.push(point);}before=point;}
        }
        for i in 1..polygon.len().saturating_sub(1){self.triangle([polygon[0],polygon[i],polygon[i+1]],color);}
    }

    pub fn disc(&mut self, x: f32, y: f32, radius: f32, color: [u8; 4]) {
        self.quad(x, y, [radius; 4], [0.0, radius, 0.0, 0.0], color);
    }

    pub fn ring(&mut self, x: f32, y: f32, radius: f32, width: f32, color: [u8; 4]) {
        let r = radius + width;
        self.quad(x, y, [r; 4], [1.0, radius, width, 0.0], color);
    }

    /// A rounded stroke from (x, y) to (x + dx, y + dy).
    pub fn stroke(&mut self, x: f32, y: f32, dx: f32, dy: f32, half_width: f32, color: [u8; 4]) {
        let h = half_width;
        self.quad(x, y, [(-dx).max(0.0) + h, (-dy).max(0.0) + h, dx.max(0.0) + h, dy.max(0.0) + h], [2.0, dx, dy, h], color);
    }

    /// The HUD's one round button (every touch and system control): a soft frosted cream bubble
    /// drawn in code at exactly its hit radius — a contact shadow, the face, a lit top, a faint
    /// rim — with its icon. `accent` tints the rim (the main action is ringed in yellow); pressed it
    /// sinks and darkens; `alpha` dims a control that does nothing right now.
    #[allow(clippy::too_many_arguments)]
    pub fn bubble(&mut self, cx: f32, cy: f32, r: f32, icon: Option<Art>, pressed: bool, accent: Option<[u8; 3]>, alpha: f32) {
        let a = alpha.clamp(0.0, 1.0);
        let sink = if pressed { 2.0 } else { 0.0 };
        let r2 = if pressed { r * 0.96 } else { r };
        if !pressed {
            self.disc(cx, cy + 3.0, r, rgba([0x0a, 0x14, 0x32], 0.22 * a));
        }
        if let Some(c) = accent {
            self.disc(cx, cy + sink, r2, rgba(c, 0.95 * a));
            self.disc(cx, cy + sink, r2 - 3.0, rgba(if pressed { [0xee, 0xe6, 0xd6] } else { [0xff, 0xfb, 0xf2] }, 0.96 * a));
        } else {
            self.disc(cx, cy + sink, r2, rgba([0xe6, 0xdc, 0xc8], 0.9 * a));
            self.disc(cx, cy + sink, r2 - 1.5, rgba(if pressed { [0xee, 0xe6, 0xd6] } else { [0xff, 0xfb, 0xf2] }, 0.94 * a));
        }
        // the lit top: a soft highlight on the upper half
        self.disc(cx, cy + sink - r2 * 0.28, r2 * 0.62, rgba(WHITE, 0.45 * a));
        if let Some(g) = icon {
            if let Some((iw, ih)) = self.art_size(g) {
                let k = 1.15 * r2 / iw.max(ih);
                let (w, h) = (iw * k, ih * k);
                self.image(g, Rect::new(cx - w / 2.0, cy + sink - h / 2.0, w, h), [255, 255, 255, (255.0 * a) as u8]);
            }
        }
    }

    /// The touch controls: the stick (a faint well when idle, the knob under the thumb when
    /// steering) and the jump button with its up chevron. Drawn with the HUD pack's pictures
    /// (assets/ui-game) once they are on the GPU, with the code-drawn shapes until then.
    pub fn touch_controls(&mut self, ui: &TouchUi, piece: usize) {
        if !ui.visible {
            return;
        }
        // the stick: a quiet frosted well (it must not cover the world), a solid knob under the thumb
        let (bx, by) = (ui.stick_base.0 as f32, ui.stick_base.1 as f32);
        let r = STICK_RADIUS as f32 + 14.0;
        let on = ui.stick_active;
        self.disc(bx, by, r, rgba([0x0a, 0x14, 0x32], if on { 0.20 } else { 0.12 }));
        self.ring(bx, by, r - 2.0, 2.0, rgba(WHITE, if on { 0.55 } else { 0.32 }));
        for k in 0..4 {
            // four small direction ticks on the rim
            let a = k as f32 * std::f32::consts::FRAC_PI_2;
            self.disc(bx + a.cos() * (r - 12.0), by + a.sin() * (r - 12.0), 2.5, rgba(WHITE, if on { 0.7 } else { 0.4 }));
        }
        let (kx, ky) = (ui.stick_knob.0 as f32, ui.stick_knob.1 as f32);
        self.bubble(kx, ky, 26.0, None, false, Some(YELLOW), if on { 1.0 } else { 0.7 });
        // the action ring
        self.bubble(ui.jump_centre.0 as f32, ui.jump_centre.1 as f32, JUMP_RADIUS as f32, Some(Art::GlyphJump), ui.jump_pressed, None, 1.0);
        if !ui.build {
            return;
        }
        self.bubble(ui.dig_centre.0 as f32, ui.dig_centre.1 as f32, DIG_RADIUS as f32, Some(Art::GlyphDig), ui.dig_pressed, Some(YELLOW), 1.0);
        self.bubble(ui.place_centre.0 as f32, ui.place_centre.1 as f32, PLACE_RADIUS as f32, Some(Art::GlyphPlace), ui.place_pressed, None, 1.0);
        let glyph = PIECE_ICONS.get(piece).copied().filter(|a| self.art_size(*a).is_some()).unwrap_or(Art::GlyphPlace);
        self.bubble(ui.shape_centre.0 as f32, ui.shape_centre.1 as f32, PLACE_RADIUS as f32, Some(glyph), ui.shape_pressed, None, 1.0);
        // turn: a small badge on the shape skill, only for a piece that turns
        if crate::building::PIECES.get(piece).is_some_and(|p| p.2) {
            self.bubble(ui.turn_centre.0 as f32, ui.turn_centre.1 as f32, crate::hud_layout::BADGE_RADIUS, Some(Art::GlyphTurn), ui.turn_pressed, Some([0x3d, 0x8b, 0xf0]), 1.0);
        }
    }

    /// A rounded rectangle, top-left (x, y), size (w, h), corner radius r — all dp.
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, color: [u8; 4]) {
        let (hw, hh) = (w.max(0.0) / 2.0, h.max(0.0) / 2.0);
        self.quad(x + hw, y + hh, [hw, hh, hw, hh], [3.0, hw, hh, r.max(0.0)], color);
    }

    /// One line of text with its box's top at y (dp). Returns the width in dp. `align` picks what x
    /// is: the left edge, the centre or the right edge.
    pub fn text(&mut self, t: &mut Text, s: &str, x: f32, y: f32, style: TextStyle) -> f32 {
        let TextStyle { size, color, align } = style;
        let s_px = self.scale;
        let px = size * s_px;
        let (placed, width) = t.line(s, px);
        let (ascent, _) = t.line_metrics(px);
        let left = match align {
            Align::Left => x * s_px,
            Align::Center => x * s_px - width / 2.0,
            Align::Right => x * s_px - width,
        }
        .round();
        let baseline = (y * s_px + ascent).round();
        for p in placed {
            let g = p.glyph;
            let (gx, gy) = (left + p.x + g.left as f32, baseline - g.top as f32);
            self.glyph_quad(gx, gy, g, color);
        }
        width / s_px
    }

    /// A glyph's pixels at physical pixel (px, py): one quad, texel for pixel.
    fn glyph_quad(&mut self, px: f32, py: f32, g: Glyph, color: [u8; 4]) {
        let (w, h) = (g.w as f32, g.h as f32);
        let (u, v) = (g.x as f32, g.y as f32);
        let shape = [4.0, 0.0, 0.0, 0.0];
        let vert = |x: f32, y: f32, lu: f32, lv: f32| UiVertex { ndc: [x / self.size.0 * 2.0 - 1.0, 1.0 - y / self.size.1 * 2.0], local: [lu, lv], shape, color };
        let (a, b, c, d) = (vert(px, py, u, v), vert(px + w, py, u + w, v), vert(px + w, py + h, u + w, v + h), vert(px, py + h, u, v + h));
        self.vertices.extend_from_slice(&[a, b, c, a, c, d]);
    }

    /// The big start button (`btn-start`, lineless): its yellow body fills `r`, the studs stand
    /// above it. Drawn in three slices so any width keeps round studs: the end caps, between them
    /// the body stretched and the stud strip tiled in whole stud periods (measured on the 1024 px picture: studs every 108.6 px, the
    /// body from y = 58). Pressed: sunk and a touch darker. False until the picture is up.
    pub fn start_button(&mut self, r: Rect, pressed: bool) -> bool {
        let Some((iw, ih)) = self.art_size(Art::BtnStart) else { return false };
        let k0 = iw / 1024.0; // the measurements are on the 1024 px build
        let (left, right, period, body_top) = (184.5 * k0, 187.5 * k0, 108.6 * k0, 58.0 * k0);
        let body_h = ih - body_top - 2.0 * k0;
        let k = r.h / body_h;
        let (top, h) = (r.y - body_top * k + if pressed { 3.0 } else { 0.0 }, ih * k);
        let tint = if pressed { [232, 222, 205, 255] } else { [255, 255, 255, 255] };
        if !pressed {
            self.rect(r.x + 10.0, r.y + 10.0, r.w - 20.0, r.h, r.h / 2.0, [0x05, 0x0f, 0x28, 0x38]);
        }
        let (lw, rw) = (left * k, right * k);
        let mid = (r.w - lw - rw).max(0.0);
        self.image_uv(Art::BtnStart, Rect::new(r.x, top, lw, h), [0.0, 0.0, left / iw, 1.0], tint);
        // the body (a smooth gradient) is stretched once, so no tile seam can show; only the stud
        // strip above it is tiled, where the gaps between studs are transparent
        let (strip, bt) = (body_top / ih, body_top * k);
        self.image_uv(Art::BtnStart, Rect::new(r.x + lw, top + bt, mid, h - bt), [left / iw, strip, (iw - right) / iw, 1.0], tint);
        let n = ((mid / (period * k)).round() as usize).max(1);
        for i in 0..n {
            let x = r.x + lw + mid * i as f32 / n as f32;
            self.image_uv(Art::BtnStart, Rect::new(x, top, mid / n as f32, bt), [left / iw, 0.0, (left + period) / iw, strip], tint);
        }
        self.image_uv(Art::BtnStart, Rect::new(r.x + r.w - rw, top, rw, h), [1.0 - right / iw, 0.0, 1.0, 1.0], tint);
        true
    }

    /// A button, lineless: the face over a darker underside of its own colour (the press lift),
    /// a soft light top; pressed, the face sinks onto it. No rim (the lineless look).
    pub fn button(&mut self, t: &mut Text, r: Rect, label: &str, style: ButtonStyle, pressed: bool, enabled: bool) {
        let (face, under, ink_text) = match (style, enabled) {
            (_, false) => (DISABLED, [0xc9, 0xc4, 0xb3], [0x8d, 0x8a, 0x7d]),
            (ButtonStyle::Primary, _) => (YELLOW, [0xe0, 0xa8, 0x10], INK),
            (ButtonStyle::Go, _) => (GREEN, [0x2f, 0x8a, 0x3c], WHITE),
            (ButtonStyle::Plain, _) => (WHITE, [0xc8, 0xd0, 0xdd], INK),
        };
        let down = if pressed && enabled { LIFT } else { 0.0 };
        let radius = (r.h / 2.0).min(18.0);
        if down == 0.0 {
            self.rect(r.x + 2.0, r.y + LIFT + 4.0, r.w - 4.0, r.h, radius, [0x0a, 0x14, 0x32, 0x22]);
        }
        self.rect(r.x, r.y + LIFT, r.w, r.h, radius, rgba(under, 1.0));
        let y = r.y + down;
        self.rect(r.x, y, r.w, r.h, radius, rgba(face, 1.0));
        self.rect(r.x + 3.0, y + 2.0, r.w - 6.0, r.h * 0.46, radius - 2.0, rgba(WHITE, 0.22));
        let size = (r.h * 0.42).clamp(13.0, 24.0);
        let fitted = t.fit(label, size * self.scale, (r.w - 20.0) * self.scale);
        let ty = y + (r.h - line_height(t, size, self.scale)) / 2.0 - 1.0;
        self.text(t, &fitted, r.x + r.w / 2.0, ty, TextStyle::new(size, rgba(ink_text, 1.0), Align::Center));
    }

    /// A text field, lineless: a soft grey well (a yellow ring when focused), its value or a grey
    /// placeholder, and a caret at the end while focused (`caret` blinks it).
    pub fn field(&mut self, t: &mut Text, r: Rect, value: &str, placeholder: &str, focused: bool, caret: bool) {
        if focused {
            self.rect(r.x - 4.0, r.y - 4.0, r.w + 8.0, r.h + 8.0, 18.0, rgba(YELLOW, 1.0));
        }
        self.rect(r.x, r.y, r.w, r.h, 14.0, [0xe6, 0xeb, 0xf3, 0xff]);
        self.rect(r.x + 2.0, r.y + 3.0, r.w - 4.0, r.h - 5.0, 12.0, rgba(WHITE, 1.0));
        let size = (r.h * 0.42).clamp(13.0, 24.0);
        let ty = r.y + (r.h - line_height(t, size, self.scale)) / 2.0;
        let room = r.w - 32.0;
        let (shown, color) = if value.is_empty() { (placeholder.to_owned(), rgba(MUTED, 1.0)) } else { (tail_fit(t, value, size * self.scale, room * self.scale), rgba(INK, 1.0)) };
        let w = self.text(t, &shown, r.x + 14.0, ty, TextStyle::new(size, color, Align::Left));
        if focused && caret {
            let cx = r.x + 14.0 + if value.is_empty() { 0.0 } else { w } + 1.5;
            self.rect(cx, r.y + r.h * 0.24, 2.5, r.h * 0.52, 1.0, rgba(INK, 1.0));
        }
    }

    /// Editing on a phone: the soft keyboard covers the lower half of a landscape screen, and a
    /// fullscreen window gets no `adjustResize` (nor, through android-activity 0.6, the keyboard's
    /// insets). So, like landscape mobile games, the screen dims and the field being edited is shown
    /// in a bar at the TOP, which every keyboard leaves visible. Returns the bar and its ✓ button.
    pub fn edit_bar(&mut self, t: &mut Text, screen_w: f32, screen_h: f32, value: &str, placeholder: &str, caret: bool) -> (Rect, Rect) {
        self.rect(0.0, 0.0, screen_w, screen_h, 0.0, rgba(INK, 0.45));
        let bar = Rect::new(12.0, 8.0, screen_w - 24.0, 76.0);
        self.rect(bar.x, bar.y + 5.0, bar.w, bar.h, 18.0, rgba(INK, 0.35));
        self.rect(bar.x, bar.y, bar.w, bar.h, 18.0, rgba(INK, 1.0));
        self.rect(bar.x + 4.0, bar.y + 4.0, bar.w - 8.0, bar.h - 8.0, 14.0, rgba(PAPER, 1.0));
        let done = Rect::new(bar.x + bar.w - 14.0 - 96.0, bar.y + 12.0, 96.0, 50.0);
        let field = Rect::new(bar.x + 14.0, bar.y + 12.0, done.x - bar.x - 28.0, 50.0);
        self.field(t, field, value, placeholder, true, caret);
        self.button(t, done, "확인", ButtonStyle::Go, false, true);
        (bar, done)
    }

    /// aimOutline.ts: a white 2.5 px line over a soft 5 px shadow (28 % black) around the aimed cell
    /// [min, max] (world). The overlay has no depth test, so only edges with a camera-facing face
    /// beside them are drawn — the cube's own hidden edges never show through it.
    pub fn aim_box(&mut self, view_proj: glam::Mat4, eye: glam::Vec3, min: glam::Vec3, max: glam::Vec3) {
        let (w, h) = self.screen();
        let corner = |i: usize| glam::Vec3::new(if i & 1 != 0 { max.x } else { min.x }, if i & 2 != 0 { max.y } else { min.y }, if i & 4 != 0 { max.z } else { min.z });
        let centre = (min + max) * 0.5;
        // a face (axis, side) faces the camera when the eye is beyond it on that axis
        let facing = |axis: usize, side: bool| if side { eye[axis] > max[axis] } else { eye[axis] < min[axis] };
        let project = |p: glam::Vec3| -> Option<(f32, f32)> {
            let c = view_proj * p.extend(1.0);
            (c.w > 0.05).then(|| ((c.x / c.w * 0.5 + 0.5) * w, (0.5 - c.y / c.w * 0.5) * h))
        };
        let mut lines: Vec<((f32, f32), (f32, f32))> = Vec::new();
        for a in 0..8usize {
            for axis in 0..3usize {
                let b = a | 1 << axis;
                if b == a {
                    continue;
                }
                // the two faces beside this edge: one on each of the other two axes
                let others: Vec<(usize, bool)> = (0..3).filter(|&k| k != axis).map(|k| (k, a & 1 << k != 0)).collect();
                if !others.iter().any(|&(k, side)| facing(k, side)) {
                    continue;
                }
                if let (Some(p), Some(q)) = (project(corner(a)), project(corner(b))) {
                    lines.push((p, q));
                }
            }
        }
        let _ = centre;
        for (half, color) in [(2.5, [0u8, 0, 0, 72]), (1.25, [255, 255, 255, 255])] {
            for &((x0, y0), (x1, y1)) in &lines {
                self.stroke(x0, y0, x1 - x0, y1 - y0, half, color);
            }
        }
    }

    /// The dig progress under the crosshair (0..1): a brick bar (`progress-frame`), code-drawn
    /// until the art is up. The cracks themselves go on the block ([`Painter::crack`]).
    pub fn dig_progress(&mut self, x: f32, y: f32, frac: f32) {
        let frac = frac.clamp(0.0, 1.0);
        let (bw, bh) = (60.0, 8.0);
        let bar = Rect::new(x - bw / 2.0, y + 26.0, bw, bh);
        if self.art_size(Art::ProgressFrame).is_some() {
            self.rect(bar.x, bar.y, bar.w, bar.h, bh / 2.0, rgba([0x16, 0x24, 0x48], 0.85));
            self.rect(bar.x, bar.y, (bar.w * frac).max(bh), bar.h, bh / 2.0, rgba(YELLOW, 1.0));
            self.nine(crate::art::frames::PROGRESS, bar, [255, 255, 255, 255]);
        } else {
            self.rect(x - bw / 2.0 - 2.0, y + 18.0, bw + 4.0, bh + 4.0, 5.0, rgba(INK, 0.7));
            self.rect(x - bw / 2.0, y + 20.0, bw * frac, bh, 3.5, rgba(WHITE, 0.95));
        }
    }

    /// The crack stage (`fx-crack-1..6`, one per sixth of the dig) over the block face being dug,
    /// `face` its screen rectangle (dp). The frames carry a white rim (baked by
    /// assets/ui-game/build.mjs), so the ink cracks read on dark stone as well as on sand.
    pub fn crack(&mut self, face: Rect, frac: f32) {
        let art = CRACK[((frac.clamp(0.0, 1.0) * 6.0) as usize).min(5)];
        if self.art_size(art).is_none() || face.w < 4.0 || face.h < 4.0 {
            return;
        }
        let r = Rect::new(face.x + face.w * 0.04, face.y + face.h * 0.04, face.w * 0.92, face.h * 0.92);
        self.image(art, r, [255, 255, 255, 255]);
    }

    /// A one-shot puff where a block landed or broke (`fx-poof-1..6`), `age` seconds after it,
    /// centred on the screen point (x, y) and sized `size` dp. Over after [`POOF_SECONDS`].
    pub fn poof(&mut self, x: f32, y: f32, size: f32, age: f32) {
        if !(0.0..POOF_SECONDS).contains(&age) {
            return;
        }
        let frame = POOF[((age / POOF_SECONDS * 6.0) as usize).min(5)];
        if self.art_size(frame).is_some() {
            self.image(frame, Rect::new(x - size / 2.0, y - size / 2.0, size, size), [255, 255, 255, 255]);
        }
    }

    /// A name plate over a head: the HUD pack's navy pill (`name-plate`) around the label.
    pub fn name_plate(&mut self, t: &mut Text, label: &str, x: f32, y: f32, gold: bool) {
        let tw = t.width(label, 14.0 * self.scale) / self.scale + 26.0;
        let r = Rect::new(x - tw / 2.0, y - 26.0, tw, 24.0);
        if self.art_size(Art::NamePlate).is_some() {
            self.nine(crate::art::frames::NAME_PLATE, r, [255, 255, 255, 255]);
        } else {
            self.rect(r.x, r.y, r.w, r.h, 12.0, [0x0b, 0x16, 0x30, 0xb8]);
        }
        self.text(t, label, x, y - 23.0, TextStyle::new(14.0, if gold { rgba(YELLOW, 1.0) } else { rgba(WHITE, 1.0) }, Align::Center));
    }

    /// The hotbar's slot rectangles (dp): hud_layout.rs places them (between the thumbs on a phone).
    pub fn hotbar_rects(w: f32, h: f32, touch: bool) -> Vec<Rect> {
        crate::hud_layout::layout(w, h, touch, false).hotbar
    }

    /// The hotbar: each slot's icon (a picture slot), its count (None: endless), the selected one
    /// lifted in yellow (the web's craft-hotbar). An empty pile is greyed out.
    pub fn hotbar(&mut self, t: &mut Text, rects: &[Rect], slots: &[(Option<usize>, Option<u32>)], selected: usize) {
        // a phone has no number keys: the numbers would be noise
        let keys = rects.first().is_some_and(|r| r.w >= 50.0) && !self.touch_hud;
        for (i, (r, (icon, count))) in rects.iter().zip(slots).enumerate() {
            let on = i == selected;
            let lift = if on { 5.0 } else { 0.0 };
            let r = Rect::new(r.x, r.y - lift, r.w, r.h);
            let rad = r.w * 0.24;
            self.rect(r.x + 1.0, r.y + 3.0 + lift * 0.4, r.w - 2.0, r.h, rad, rgba([0x0a, 0x14, 0x32], 0.25));
            if on {
                self.rect(r.x - 3.0, r.y - 3.0, r.w + 6.0, r.h + 6.0, rad + 3.0, rgba(YELLOW, 1.0));
                self.rect(r.x, r.y, r.w, r.h, rad, rgba([0xff, 0xfb, 0xf2], 0.97));
            } else {
                self.rect(r.x, r.y, r.w, r.h, rad, rgba([0x16, 0x24, 0x48], 0.55));
                self.rect(r.x + 1.5, r.y + 1.5, r.w - 3.0, r.h * 0.45, rad - 1.5, rgba(WHITE, 0.08));
            }
            let empty = count == &Some(0);
            if let Some(slot) = icon {
                let pad = r.w * 0.15;
                self.slot_image(*slot, Rect::new(r.x + pad, r.y + pad, r.w - 2.0 * pad, r.h - 2.0 * pad), if empty { [255, 255, 255, 115] } else { [255, 255, 255, 255] });
            }
            let small = (r.w * 0.26).clamp(10.0, 13.5);
            if keys {
                self.text(t, &format!("{}", (i + 1) % 10), r.x + 5.0, r.y + 2.0, TextStyle::new(small, if on { rgba(INK, 0.6) } else { rgba(WHITE, 0.6) }, Align::Left));
            }
            let label = match count {
                None if i == 9 => "∞".to_owned(),
                Some(n) if *n > 0 => n.to_string(),
                _ => String::new(),
            };
            if !label.is_empty() {
                // a count in the corner, white with a soft dark edge (no badge box)
                let (x, y) = (r.x + r.w - 5.0, r.y + r.h - small - 4.0);
                self.text(t, &label, x + 1.0, y + 1.0, TextStyle::new(small + 1.0, rgba(INK, 0.55), Align::Right));
                self.text(t, &label, x, y, TextStyle::new(small + 1.0, if on { rgba(INK, 1.0) } else { rgba(WHITE, 1.0) }, Align::Right));
            }
        }
    }


    /// The pet chip (top left, under the field's top bar) and, when open, the row beside it: the
    /// five animals in adoption order, then sit/follow.
    /// A system button (the top-right strip): a round plastic face with its glyph, dimmed while
    /// pressed or open.
    pub fn sys_button(&mut self, r: Rect, glyph: Art, pressed: bool) {
        self.bubble(r.x + r.w / 2.0, r.y + r.h / 2.0, r.w / 2.0, Some(glyph), pressed, None, 1.0);
    }

    /// The player plate (top-left): an avatar disc with an icon, a title and, on the right, a
    /// status (a green dot and a count), on soft navy glass — the corner a game keeps for "me".
    pub fn plate(&mut self, t: &mut Text, r: Rect, icon: Art, title: &str, status: Option<&str>) {
        self.rect(r.x + 2.0, r.y + 5.0, r.w - 4.0, r.h, r.h / 2.0, [0x05, 0x0f, 0x28, 0x30]);
        self.rect(r.x, r.y, r.w, r.h, r.h / 2.0, [0x16, 0x24, 0x48, 0xe6]);
        self.rect(r.x + 2.0, r.y + 2.0, r.w - 4.0, r.h * 0.5, r.h / 2.0 - 2.0, [0xff, 0xff, 0xff, 0x14]);
        let d = r.h - 8.0;
        self.disc(r.x + 4.0 + d / 2.0, r.y + r.h / 2.0, d / 2.0, rgba(PAPER, 1.0));
        if let Some((iw, ih)) = self.art_size(icon) {
            let k = d * 0.72 / iw.max(ih);
            self.image(icon, Rect::new(r.x + 4.0 + d / 2.0 - iw * k / 2.0, r.y + r.h / 2.0 - ih * k / 2.0, iw * k, ih * k), [255, 255, 255, 255]);
        }
        let status_w = status.map_or(0.0, |s| t.width(s, 15.0 * self.scale) / self.scale + 30.0);
        let tx = r.x + d + 14.0;
        let title = t.fit(title, 16.0 * self.scale, (r.x + r.w - 12.0 - status_w - tx) * self.scale);
        self.text(t, &title, tx, r.y + (r.h - line_height(t, 16.0, self.scale)) / 2.0, TextStyle::new(16.0, rgba(WHITE, 1.0), Align::Left));
        if let Some(st) = status {
            self.disc(r.x + r.w - status_w + 4.0, r.y + r.h / 2.0, 4.5, [0x4c, 0xd9, 0x64, 0xff]);
            self.text(t, st, r.x + r.w - 14.0, r.y + (r.h - line_height(t, 15.0, self.scale)) / 2.0, TextStyle::new(15.0, rgba(WHITE, 1.0), Align::Right));
        }
    }

    /// The emote panel (hud_layout::emote_panel): frosted navy glass, a label per row, pills for
    /// the gestures, the postures (the one taken lit) and the two characters (the chosen one lit).
    pub fn emote_panel(&mut self, t: &mut Text, w: f32, posture: crate::character::Posture, tt: bool) {
        use crate::character::Posture as P;
        use crate::hud_layout::EmoteItem as E;
        let (panel, items, labels) = crate::hud_layout::emote_panel(w);
        self.rect(panel.x + 2.0, panel.y + 6.0, panel.w - 4.0, panel.h, 20.0, [0x05, 0x0f, 0x28, 0x38]);
        self.rect(panel.x, panel.y, panel.w, panel.h, 20.0, [0x16, 0x24, 0x48, 0xf0]);
        self.rect(panel.x + 2.0, panel.y + 2.0, panel.w - 4.0, 30.0, 18.0, [0xff, 0xff, 0xff, 0x10]);
        for (y, label) in labels {
            self.text(t, label, panel.x + 18.0, y, TextStyle::new(14.0, rgba(WHITE, 0.7), Align::Left));
        }
        for (it, r) in items {
            let (label, on) = match it {
                E::Smile => ("미소", false),
                E::Laugh => ("활짝", false),
                E::Wink => ("윙크", false),
                E::Wave => ("손 흔들기", false),
                E::Cheer => ("신나게", false),
                E::Sit => ("앉기", posture == P::Sit),
                E::Lie => ("눕기", posture == P::Lie),
                E::Stand => ("서기", posture == P::Stand),
                E::Home => ("HOME", !tt),
                E::Tt => ("TT", tt),
            };
            let rad = r.h / 2.0;
            self.rect(r.x, r.y + 2.0, r.w, r.h, rad, [0x05, 0x0f, 0x28, 0x30]);
            self.rect(r.x, r.y, r.w, r.h, rad, if on { rgba(YELLOW, 1.0) } else { [0xff, 0xfb, 0xf2, 0xf2] });
            let fitted = t.fit(label, 14.0 * self.scale, (r.w - 10.0) * self.scale);
            self.text(t, &fitted, r.x + r.w / 2.0, r.y + (r.h - line_height(t, 14.0, self.scale)) / 2.0, TextStyle::new(14.0, rgba(INK, 1.0), Align::Center));
        }
    }

    /// The pet button (its rect from the layout) and, open, its row of picks.
    pub fn pet_rects(chip: Rect, row: &[Rect], open: bool) -> (Rect, Vec<Rect>) {
        (chip, if open { row.to_vec() } else { Vec::new() })
    }

    /// The pet chip: a round button with the adopted animal's head (the paw while the pictures
    /// load); open, the five heads (the adopted one ringed in yellow) and a sit/follow button.
    pub fn pet_hud(&mut self, t: &mut Text, chip: Rect, row: &[Rect], open: bool, adopted: usize, sitting: bool) {
        let (chip, picks) = Self::pet_rects(chip, row, open);
        let face = PETS.get(adopted).copied().filter(|a| self.art_size(*a).is_some()).unwrap_or(Art::GlyphPaw);
        let (cx, cy) = (chip.x + chip.w / 2.0, chip.y + chip.h / 2.0);
        self.bubble(cx, cy, chip.w / 2.0, Some(face), open, None, 1.0);
        if sitting && !open {
            // a little "sit" tag under the chip, so a pet left behind is not a mystery
            self.rect(cx - 20.0, chip.y + chip.h - 4.0, 40.0, 18.0, 9.0, rgba(GREEN, 1.0));
            self.text(t, "앉아", cx, chip.y + chip.h - 3.0, TextStyle::new(12.0, rgba(WHITE, 1.0), Align::Center));
        }
        for (i, r) in picks.iter().enumerate() {
            let (px, py) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
            if i < 5 {
                self.bubble(px, py, r.w / 2.0, PETS.get(i).copied(), false, (i == adopted).then_some(YELLOW), 1.0);
            } else {
                let label = if sitting { "따라와" } else { "앉아" };
                let b = Rect::new(r.x, r.y + 4.0, r.w, r.h - 8.0);
                self.rect(b.x, b.y + 3.0, b.w, b.h, b.h / 2.0, rgba(INK, 0.5));
                self.rect(b.x, b.y, b.w, b.h, b.h / 2.0, rgba(if sitting { GREEN } else { YELLOW }, 1.0));
                self.text(t, label, b.x + b.w / 2.0, b.y + (b.h - 16.0) / 2.0, TextStyle::new(14.0, rgba(INK, 1.0), Align::Center));
            }
        }
    }

    /// The bag panel (bag.rs) over the play screen, drawn from the same `Layout` its taps use:
    /// lineless navy glass, the 가방 title and a close button, the category tabs, a tile per item
    /// (its picture, its count — none: endless), and a hint naming the armed hotbar slot.
    /// `items`: per shown item (picture slot, count).
    pub fn bag(&mut self, t: &mut Text, l: &crate::bag::Layout, items: &[(Option<usize>, Option<u32>)], tab: usize, armed: usize) {
        let p = l.panel;
        self.rect(p.x + 2.0, p.y + 8.0, p.w - 4.0, p.h, 22.0, [0x05, 0x0f, 0x28, 0x40]);
        self.rect(p.x, p.y, p.w, p.h, 22.0, [0x16, 0x24, 0x48, 0xf2]);
        self.rect(p.x + 2.0, p.y + 2.0, p.w - 4.0, 44.0, 20.0, [0xff, 0xff, 0xff, 0x10]);
        if let Some((iw, ih)) = self.art_size(Art::GlyphBag) {
            let k = 28.0 / iw.max(ih);
            self.image(Art::GlyphBag, Rect::new(p.x + 14.0, p.y + 9.0, iw * k, ih * k), [255, 255, 255, 255]);
        }
        self.text(t, "가방", p.x + 50.0, p.y + 11.0, TextStyle::new(19.0, rgba(WHITE, 1.0), Align::Left));
        // the close button: a soft disc with an x
        let (cx, cy) = (l.close.x + l.close.w / 2.0, l.close.y + l.close.h / 2.0);
        self.disc(cx, cy, 16.0, [0xff, 0xff, 0xff, 0x24]);
        self.stroke(cx - 6.0, cy - 6.0, 12.0, 12.0, 1.8, rgba(WHITE, 0.95));
        self.stroke(cx + 6.0, cy - 6.0, -12.0, 12.0, 1.8, rgba(WHITE, 0.95));
        for (i, r) in l.tabs.iter().enumerate() {
            let on = i == tab;
            self.rect(r.x, r.y, r.w, r.h, r.h / 2.0, if on { rgba(WHITE, 1.0) } else { [0xff, 0xff, 0xff, 0x16] });
            let label = crate::building::BAG_GROUPS.get(i).map_or("", |g| g.1);
            let fitted = t.fit(label, 13.5 * self.scale, (r.w - 6.0) * self.scale);
            self.text(t, &fitted, r.x + r.w / 2.0, r.y + (r.h - line_height(t, 13.5, self.scale)) / 2.0, TextStyle::new(13.5, if on { rgba(INK, 1.0) } else { rgba(WHITE, 0.85) }, Align::Center));
        }
        let hint = format!("{}번 칸에 넣을 걸 골라요 · 칸을 누르면 바꿀 칸을 골라요", (armed + 1) % 10);
        let hint = t.fit(&hint, 12.5 * self.scale, (p.w - 28.0) * self.scale);
        self.text(t, &hint, p.x + 14.0, l.grid.y - 19.0, TextStyle::new(12.5, rgba(WHITE, 0.7), Align::Left));
        for &(i, r) in &l.tiles {
            let Some(&(icon, count)) = items.get(i) else { continue };
            // clipped by the grid: a tile half out of it is drawn faded rather than over the tabs
            let inside = r.y >= l.grid.y - 0.5 && r.y + r.h <= l.grid.y + l.grid.h + 0.5;
            let a = if inside { 1.0 } else { 0.35 };
            self.rect(r.x, r.y + 3.0, r.w, r.h, 14.0, rgba([0x05, 0x0f, 0x28], 0.3 * a));
            self.rect(r.x, r.y, r.w, r.h, 14.0, rgba(PAPER, a));
            if let Some(slot) = icon {
                let pad = r.w * 0.16;
                self.slot_image(slot, Rect::new(r.x + pad, r.y + pad, r.w - 2.0 * pad, r.h - 2.0 * pad), [255, 255, 255, (255.0 * a) as u8]);
            }
            if let (Some(n), true) = (count, inside) {
                let label = n.to_string();
                let lw = t.width(&label, 12.0 * self.scale) / self.scale + 9.0;
                self.rect(r.x + r.w - lw - 3.0, r.y + r.h - 20.0, lw, 17.0, 8.5, rgba(INK, 0.85));
                self.text(t, &label, r.x + r.w - 7.5, r.y + r.h - 19.0, TextStyle::new(12.0, rgba(WHITE, 1.0), Align::Right));
            }
        }
        if l.tiles.is_empty() {
            self.text(t, "아직 비어 있어요 · 블록을 캐면 여기에 모여요", p.x + p.w / 2.0, l.grid.y + 20.0, TextStyle::new(14.0, rgba(WHITE, 0.75), Align::Center));
        }
    }

    /// The armed hotbar slot while the bag is open: a soft yellow ring that breathes.
    pub fn armed_ring(&mut self, r: Rect, time: f32) {
        let a = 0.55 + 0.35 * (time * 5.0).sin();
        self.rect(r.x - 6.0, r.y - 10.0, r.w + 12.0, r.h + 14.0, 14.0, rgba(YELLOW, a));
    }

    /// The aim point: a small white cross with an ink outline (the web's craft-crosshair).
    pub fn crosshair(&mut self, x: f32, y: f32) {
        for (c, w) in [(rgba(INK, 0.7), 3.2), (rgba(WHITE, 0.95), 1.6)] {
            self.stroke(x - 9.0, y, 18.0, 0.0, w, c);
            self.stroke(x, y - 9.0, 0.0, 18.0, w, c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_land_where_they_are_asked_in_ndc() {
        let mut p = Painter::new((1000, 500), 2.0);
        p.disc(250.0, 125.0, 10.0, [255; 4]); // dp → px (500, 250) = the centre
        let xs: Vec<f32> = p.vertices.iter().map(|v| v.ndc[0]).collect();
        let ys: Vec<f32> = p.vertices.iter().map(|v| v.ndc[1]).collect();
        let mid = |v: &[f32]| (v.iter().cloned().fold(f32::MAX, f32::min) + v.iter().cloned().fold(f32::MIN, f32::max)) / 2.0;
        assert!(mid(&xs).abs() < 1e-6 && mid(&ys).abs() < 1e-6);
        // radius scaled to physical pixels
        assert_eq!(p.vertices[0].shape[1], 20.0);
    }

    #[test]
    fn hidden_touch_controls_paint_nothing() {
        let mut p = Painter::new((800, 400), 1.0);
        p.touch_controls(&TouchUi::default(), 0);
        assert!(p.vertices.is_empty());
        p.touch_controls(&TouchUi { visible: true, ..Default::default() }, 0);
        assert!(!p.vertices.is_empty() && p.vertices.len().is_multiple_of(6));
    }
}
