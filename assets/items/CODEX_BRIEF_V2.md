# Brief v2: wind turbine — richer foundation, a robot-sized door, a generator you can recognise, a real terminal

Follow-up to `frames/CODEX_BRIEF.md` and `parts/CODEX_BRIEF.md` (read both first: same style, same rules —
soft clay/satin, rounded bevels, no outlines, no textures, metres, +Y up, front +Z, root node = key).
`frames/previews/turbine-assembled.png` is the current result. Playtest feedback:

1. The FOUNDATION is too plain.
2. The DOOR is far too small: the player character is a robot about **1.8 m tall and 0.9 m wide**, so a
   0.5 m door looks like a toy. The tower base becomes **two cells tall** with a door the robot fits through.
3. The GENERATOR is too simple — kids don't recognise it. It may be **two cells long**.
4. The WIRE TERMINAL is too small and simple as well.

Use Blender (the `blender` MCP, or headless:
`"C:\Users\AI배움터\Downloads\blender-5.4.0-alpha+main.0d0b51704b28-windows.amd64-release\blender-5.4.0-alpha+main.0d0b51704b28-windows.amd64-release\blender.exe" --background --factory-startup --python-exit-code 1 --python <script>`).
Update the existing build scripts (`frames/source/build_frames.py`, `parts/source/build_parts.py`) so everything stays
re-runnable, re-export, and update both `runtime/manifest.json` files. Only the pieces below change; keep the others.

## New turbine layout (cells, rotation 0, +Z front, y = layer above ground)
- y=0: 3×3 foundation (`frame-foundation` ×8, `frame-foundation-center` in the middle).
- y=1..2: `frame-tower-base` — ONE piece spanning TWO cells (0,1,0)+(0,2,0).
- y=3..5: `frame-tower` ×3. y=6: `frame-tower-top`.
- y=7: `frame-nacelle-tail` at z=−2 (unchanged model), `part-generator` spanning TWO cells z=−1..0,
  `frame-hub` at z=+1, `part-blades` at z=+2.
- `part-wire-terminal` at (1,1,0), on the foundation beside the tower (the tower is on its −X side).

## Pieces to (re)make
Multi-cell pieces have their origin at the CENTRE OF THEIR WHOLE VOLUME.

1. `frame-foundation` (1 cell, must still tile seamlessly 3×3, sides flush at ±0.5): a richer concrete pad —
   chamfered top edge, a shallow recessed panel / grout lines on top, a thin steel edge trim, small corner
   bolt heads, slightly darker lower skirt. ≤ 1500 tris.
2. `frame-foundation-center` (1 cell): same pad plus a raised round plinth with the steel anchor ring and
   12 bolts the tower stands on (ring top at y=+0.5). ≤ 2000 tris.
3. `frame-tower-base` (1×2×1 cells: x,z −0.5..0.5, y −1..+1): white tube ~0.8 m dia, flaring to ~0.95 m at the
   bottom flange; a DOOR on +Z about **1.7 m tall × 0.55 m wide** from the bottom (so the 1.8 m robot reads as
   fitting it — the door may cut into the flare), rounded, navy, with a handle and a small window; a little
   steel step in front of the door; a lamp above it; the yellow stripe. ≤ 2500 tris.
4. `part-generator` (1×1×2 cells: z −1..+1, sits with its base at y = −0.45): make it unmistakably a GENERATOR
   — a big cylindrical stator housing along Z with cooling ribs, a cut-away window on the side showing the
   copper COIL windings and a rotor with RED and BLUE MAGNETS inside (that is the science the game teaches:
   a magnet turning inside a coil makes electricity), a terminal box on top with two thick cables, the shaft
   leaving the FRONT (+Z) through a coupling disc, mounting feet on a base frame, a yellow ⚡ plate.
   ≤ 6000 tris.
5. `part-wire-terminal` (1 cell, floor at y=−0.5): a robot-scale electrical CABINET ~0.7 w × 0.95 h ×
   0.55 d — rounded navy body, a front door (+Z) with a yellow ⚡ warning triangle and a handle, a vent
   grille, two big terminal posts on top with RED and BLACK caps, a thick cable leaving low on the −X side
   (toward the tower) and a conduit going down into the ground. ≤ 3000 tris.

## Renders
- `frames/previews/frames-sheet.png` and `parts/previews/parts-sheet.png` — refreshed sheets.
- `frames/previews/turbine-assembled.png` — the whole turbine in the NEW layout, plus a plain yellow
  rounded box 0.9 × 1.8 × 0.7 m standing beside the door as the robot SCALE FIGURE, 3/4 view from the front-right.
- `frames/previews/door-closeup.png` and `parts/previews/generator-closeup.png` — close-ups.

Reply with the files changed and triangle counts. Do not modify anything outside `assets/items/frames` and `assets/items/parts`.
