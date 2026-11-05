//! CraftYap online for the native client: the wire protocol ([`protocol`]) and the WebSocket link
//! ([`link`]) to the same server the web game uses. Nothing here touches the renderer or the world,
//! so it is tested on its own (fixtures from the zod schemas; a live run against `pnpm dev`).

pub mod hub;
pub mod link;
pub mod protocol;
