//! CraftYap engine core: pure simulation shared by every target (browser via WASM, native apps,
//! the server). No rendering, no I/O, no platform code here.

pub mod fluid;
pub mod field;
pub mod grid;
