# Brief: model the wind turbine's building FRAME (뼈대) in Blender

CraftYap is a soft, toy-like, LEGO-ish voxel game (1 block = 1 m). Kids build a wind turbine from a
blueprint. Until now its body was plain blocks; it should be built from dedicated FRAME pieces instead,
each filling exactly one 1 m cell, which together make a believable small wind turbine. The three PARTS
that fit into it already exist (`previews/part-*.glb`, see `previews/parts-style-ref.png`); match their
style exactly: soft clay/satin look, rounded bevels (2–4 cm), smooth shading, NO outlines, no textures.
`previews/ingame-current.png` shows how the turbine looks today in plain blocks.

Use Blender. The Blender MCP (`blender` server) is available; alternatively run headless:
`"C:\Users\AI배움터\Downloads\blender-5.4.0-alpha+main.0d0b51704b28-windows.amd64-release\blender-5.4.0-alpha+main.0d0b51704b28-windows.amd64-release\blender.exe" --background --factory-startup --python-exit-code 1 --python <script>`.
Write a re-runnable `source/build_frames.py` that builds everything from scratch and exports, then run it.

## The turbine layout (cells, rotation 0, +Z = front, y = layer above the ground)
- y=0: a 3×3 FOUNDATION (x,z ∈ −1..1). Centre cell (0,0,0) is where the tower stands.
- y=1..6: the TOWER, one cell wide at (0,y,0). y=1 is the base segment (with a door facing +Z), y=2..5 plain segments, y=6 the top segment.
- y=7: the NACELLE: tail at (0,7,−1), the GENERATOR part at (0,7,0) (exists), the HUB at (0,7,1), the BLADES part at (0,7,2) (exists).
- The WIRE TERMINAL part sits at (1,1,0) on top of the foundation (exists).

## Frame pieces to make (one GLB each)
Every piece: origin = the centre of its 1 m cell, metres, +Y up, front +Z, root node named exactly the key.
Ends that touch a neighbour must meet it cleanly (flush faces at ±0.5 where they join; no gaps, no overlap
that would z-fight). Triangle budget ≤ 1500 each (they repeat). Colours (sRGB): concrete #C9CDD3, darker
concrete #A9AFB8, tower white #F2F4F7, flange/steel #AEB8C2, dark steel #7F8994, door #4A6496,
nacelle white #F4F6F8, accent stripe #FFCF3A, bolt steel #8E98A3.

1. `frame-foundation` — a concrete pad block filling the whole cell (−0.5..0.5), top edges softly
   chamfered, a faint panel seam; it must tile seamlessly in a 3×3 (sides flat and flush at ±0.5).
2. `frame-foundation-center` — same pad, plus a round steel base ring with 8 anchor bolts on top where
   the tower stands (ring top at y=+0.5, tower dia ~0.8 m).
3. `frame-tower-base` — tower segment: white tube ~0.8 m dia from y=−0.5 to +0.5 with a steel flange at
   the bottom, a small rounded navy door on the +Z side, and a thin yellow accent stripe.
4. `frame-tower` — plain stackable white tube segment (~0.78 m dia), a thin steel flange ring at its top;
   stacked 4 high it must read as one smooth tower with flange joints.
5. `frame-tower-top` — the last segment, tapering slightly (~0.72 m at the top), with a steel yaw
   bearing (turntable ring) on top that the nacelle/generator sits on.
6. `frame-nacelle-tail` — the rear of the nacelle housing: a rounded white shell filling most of the cell,
   closed and rounded at the back (−Z), OPEN at the front (+Z face, where the generator cell is), small
   vents on the sides, a little wind vane/anemometer on top.
7. `frame-hub` — the front housing that carries the rotor: rounded white shell, open at the back (−Z,
   toward the generator), a steel round flange plate on the FRONT face (+Z) at z=+0.5 where the
   blades' hub mounts.

## Output (all inside this folder)
- `source/build_frames.py`, `source/Frames.blend`
- `runtime/<key>.glb` for the 7 keys above (glTF binary, applied transforms, embedded PBR colours)
- `runtime/manifest.json` — per file: triangle count, bounding box, node names
- `previews/frames-sheet.png` — the 7 pieces side by side, labelled
- `previews/turbine-assembled.png` — the WHOLE turbine assembled from the 7 frame pieces at the cell
  positions above PLUS the 3 existing parts (import `previews/part-*.glb` at their cells: generator
  (0,7,0), blades (0,7,2), terminal (1,1,0)), 3/4 view, soft light, plain light background. This is the
  image a human will judge.

Reply with the files written and triangle counts. Do not modify anything outside this folder.
