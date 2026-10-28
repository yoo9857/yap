# HOME character

The game uses `player/homeRig.ts` through the existing `CharacterRig` API.
`main.ts` preloads the GLB and face atlases before any game mode constructs a rig.
If an asset fails, the built-in procedural mascot remains the fallback.

- Model: `public/models/characters/HOME/HOME.glb` (in game) and `TT/TT.glb` (the second character, picked from the C emote menu), CC0 derivatives of Kenney Mini Characters. Faces are per-character PNGs plus frame sequences listed in `models/characters/face-animations.json`. `public/models/home/home-v4.glb` is now only used by `/home-preview.html`.
- One skinned mesh, 2,356 triangles. Short arms have one shoulder pivot each.
- Three color variants share geometry and textures, with separate skeletons and face materials per player.
- Feet at the origin, forward +Z, Y up. Gameplay owns root position and yaw.
- Shared texture registry, screen-space ink, skinned XR hull, camera opacity and disposal contracts are retained.

Clips: Idle, IdleShift, IdleLook, Walk, Run, Wave, Jump, Fall, Land, Carry, Hold, Place, Sit.
Jump and Fall alternate the short arms/feet; root height follows the existing physics.
A landing pose and the existing squash spring absorb touchdown. Animation speed is capped for the game's fast movement.

`/home-preview.html` is included in the production build. Space runs a jump/fall/landing review.
`/?preview=char` uses the actual game adapter with all three variants and pets.

Validation: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
The HOME asset test checks the shipped GLB, resource ownership, opacity/face independence,
continuous airborne limb motion, root transform ownership and landing transitions.

For model edits, preserve the short, uniform arm silhouette and thumb-only block mitten.
Do not add separate shoulder, elbow or wrist bulges.
