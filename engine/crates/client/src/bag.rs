//! The bag (the web's bag.ts Blocks tab, for a phone): what you own as a grid of tiles under
//! category tabs, and the hotbar as the thing it loads. Loading a slot is the web's rule — pick a
//! hotbar slot (it arms, yellow), then tap an item: it goes in that slot (a key already on the bar
//! trades places, inventory.ts assignHotbar) and the next slot arms, so filling the bar is a run of
//! taps. The bucket's slot never changes.
//!
//! Layout is a pure function (`layout`) used both to draw and to hit-test, so what is drawn is what
//! a tap hits. The crafting tab is not here yet.

use crate::building::{item_group, BAG_GROUPS, WATER_SLOT};
use crate::ui::Rect;

/// A tile's size and the gap between tiles (dp).
pub const TILE: f32 = 58.0;
const GAP: f32 = 8.0;
/// The panel's header (title + close) and the tab row (dp).
const HEAD: f32 = 46.0;
const TABS: f32 = 40.0;

#[derive(Default)]
pub struct Bag {
    pub open: bool,
    /// The tab (index into BAG_GROUPS).
    pub tab: usize,
    /// The hotbar slot the next tapped item goes into.
    pub armed: usize,
    /// How far the grid is scrolled (dp).
    pub scroll: f32,
}

/// Where everything is this frame (dp).
pub struct Layout {
    pub panel: Rect,
    pub close: Rect,
    pub tabs: Vec<Rect>,
    /// The grid's visible area (tiles are clipped to it by not drawing those outside).
    pub grid: Rect,
    /// (index into the shown items, its tile) for every tile at least partly visible.
    pub tiles: Vec<(usize, Rect)>,
    /// The furthest the grid can scroll.
    pub max_scroll: f32,
}

/// The items a tab shows: (key, count) filtered by the tab's group ("all" shows everything).
pub fn shown<'a>(items: &'a [(&'static str, Option<u32>)], tab: usize) -> Vec<&'a (&'static str, Option<u32>)> {
    let group = BAG_GROUPS.get(tab).map_or("all", |g| g.0);
    items.iter().filter(|(k, _)| group == "all" || item_group(k) == Some(group)).collect()
}

/// The bag's layout on a `w` × `h` dp screen, beside the side column (`left`) and above the
/// hotbar (`bottom` = its top), for `n` shown items scrolled by `scroll`.
pub fn layout(w: f32, _h: f32, left: f32, bottom: f32, n: usize, scroll: f32) -> Layout {
    let top = crate::hud_layout::MARGIN + crate::hud_layout::TOP + 10.0;
    let panel = Rect::new(left, top, (w - left - crate::hud_layout::MARGIN).max(200.0), (bottom - 10.0 - top).max(160.0));
    let close = Rect::new(panel.x + panel.w - 44.0, panel.y + 6.0, 36.0, 36.0);
    let tab_y = panel.y + HEAD;
    let mut tabs = Vec::new();
    let tab_w = ((panel.w - 24.0) / BAG_GROUPS.len() as f32).clamp(44.0, 84.0);
    for i in 0..BAG_GROUPS.len() {
        tabs.push(Rect::new(panel.x + 12.0 + i as f32 * tab_w, tab_y, tab_w - 4.0, TABS - 8.0));
    }
    let grid = Rect::new(panel.x + 12.0, tab_y + TABS + 22.0, panel.w - 24.0, (panel.y + panel.h - 10.0) - (tab_y + TABS + 22.0));
    let cols = (((grid.w + GAP) / (TILE + GAP)).floor() as usize).max(1);
    let rows = n.div_ceil(cols);
    let content = rows as f32 * (TILE + GAP) - GAP;
    let max_scroll = (content - grid.h).max(0.0);
    let scroll = scroll.clamp(0.0, max_scroll);
    // the tiles centred in the grid's width
    let x0 = grid.x + (grid.w - (cols as f32 * (TILE + GAP) - GAP)) / 2.0;
    let mut tiles = Vec::new();
    for i in 0..n {
        let (c, r) = (i % cols, i / cols);
        let t = Rect::new(x0 + c as f32 * (TILE + GAP), grid.y + r as f32 * (TILE + GAP) - scroll, TILE, TILE);
        if t.y + t.h > grid.y && t.y < grid.y + grid.h {
            tiles.push((i, t));
        }
    }
    Layout { panel, close, tabs, grid, tiles, max_scroll }
}

impl Bag {
    pub fn toggle(&mut self, selected: usize) {
        self.open = !self.open;
        if self.open {
            // the slot in hand is the one a tap fills first (the web arms the selected slot)
            self.armed = selected.min(WATER_SLOT - 1);
            self.scroll = 0.0;
        }
    }

    /// After loading `slot`, the next one arms (bag.ts: a click fills the next slot).
    pub fn advance(&mut self, slot: usize) {
        self.armed = (slot + 1) % WATER_SLOT;
    }

    pub fn arm(&mut self, slot: usize) {
        if slot < WATER_SLOT {
            self.armed = slot;
        }
    }

    pub fn set_tab(&mut self, tab: usize) {
        if tab < BAG_GROUPS.len() && tab != self.tab {
            self.tab = tab;
            self.scroll = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::building::{Hotbar, PICKAXE_KEY};

    #[test]
    fn the_layout_fits_the_screen_and_scrolls_only_what_overflows() {
        let field = Hotbar::field().items();
        let l = layout(914.0, 411.0, 76.0, 345.0, field.len(), 0.0);
        assert!(l.panel.x >= 76.0 && l.panel.x + l.panel.w <= 914.0 && l.panel.y + l.panel.h <= 345.0);
        assert!(l.tiles.iter().all(|(_, t)| t.x >= l.grid.x - 0.5 && t.x + t.w <= l.grid.x + l.grid.w + 0.5));
        assert!(l.max_scroll > 0.0, "every block does not fit on a phone");
        let end = layout(914.0, 411.0, 76.0, 345.0, field.len(), 1e9);
        assert!(end.tiles.iter().any(|(i, _)| *i == field.len() - 1), "scrolled to the end, the last item shows");
        // a few items: no scrolling
        let few = layout(914.0, 411.0, 76.0, 345.0, 3, 50.0);
        assert_eq!(few.max_scroll, 0.0);
        assert_eq!(few.tiles.len(), 3);
    }

    #[test]
    fn tabs_filter_and_the_run_of_taps_fills_the_bar() {
        let items = Hotbar::field().items();
        let tools = BAG_GROUPS.iter().position(|g| g.0 == "tools").unwrap();
        assert_eq!(shown(&items, tools).iter().map(|i| i.0).collect::<Vec<_>>(), vec![PICKAXE_KEY]);
        assert_eq!(shown(&items, 0).len(), items.len(), "all");
        let mut bag = Bag::default();
        bag.toggle(3);
        assert!(bag.open && bag.armed == 3);
        bag.advance(8);
        assert_eq!(bag.armed, 0, "after the last block slot it wraps, never onto the bucket");
        bag.arm(WATER_SLOT);
        assert_eq!(bag.armed, 0, "the bucket cannot be armed");
    }
}
