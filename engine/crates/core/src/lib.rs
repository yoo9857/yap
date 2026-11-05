//! CraftYap engine core: pure simulation and geometry shared by every target (browser via WASM,
//! native apps, the server). No rendering, no I/O, no platform code here.

pub mod blocks_gen;
pub mod earcut;
pub mod field;
pub mod fluid;
pub mod grid;
pub mod kit;
pub mod scan;
pub mod surface;
pub mod world;
