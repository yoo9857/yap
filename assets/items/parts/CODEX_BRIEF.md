# Brief: model the three power-plant parts in Blender

You are modeling three game items for CraftYap (a soft, toy-like, LEGO-ish voxel game; 1 block = 1 m).
They are fitted into a wind turbine built from 1 m blocks. Match the attached icon art in
`previews/*-icon-ref.png` (soft clay/satin look, rounded bevels, NO outlines).

Use Blender. The Blender MCP (`blender` server) is available; alternatively run Blender headless:
`"C:\Users\AI배움터\Downloads\blender-5.4.0-alpha+main.0d0b51704b28-windows.amd64-release\blender-5.4.0-alpha+main.0d0b51704b28-windows.amd64-release\blender.exe" --background --factory-startup --python-exit-code 1 --python <script>`.
Prefer a reproducible build script: write `source/build_parts.py` that builds all three from scratch and exports them, then run it.

## Output (all inside this folder)
- `source/build_parts.py` — the build script (re-runnable).
- `source/Parts.blend` — the saved scene.
- `runtime/part-generator.glb`, `runtime/part-blades.glb`, `runtime/part-wire-terminal.glb` — glTF binary, +Y up, metres, materials embedded (Principled BSDF → glTF PBR: base colour, roughness, metallic; NO image textures), applied transforms, smooth/auto-smooth normals.
- `runtime/manifest.json` — per file: triangle count, bounding box (min/max in metres), node names.
- `previews/parts-sheet.png` — one render of all three side by side (3/4 view, soft light, plain light background) so a human can judge them against the icons.

## Shared rules
- Origin (0,0,0) = the CENTRE of the 1 m slot cell the part sits in. The part's FRONT faces +Z (glTF +Z).
- Units metres. Keep everything inside the cell (−0.5…+0.5 on every axis) EXCEPT the rotor blades (see below).
- Soft, rounded: bevel every hard edge (2–4 cm), no razor edges. Low-poly but smooth: use bevels + smooth shading, not dense subdivision.
- Triangle budget: generator ≤ 3000, wire terminal ≤ 2500, blades ≤ 3000 (whole file).
- Colours (sRGB hex, match the icons): steel grey #AEB8C2, dark steel #7F8994, copper #D98A4A (metallic ~0.6, roughness ~0.35), soft green base #86AD94, white blade #F4F6F8, hub grey #C9CFD6, nose blue #6FA8E8, navy box #4A6496, red cap #E0564F, black cap #3A3D44, lightning yellow #FFCF3A.
- Name the root node exactly the file's part key (`part-generator`, `part-blades`, `part-wire-terminal`).

## 1. part-generator (sits in the nacelle on top of the tower; the hub block is in front at +Z)
A short horizontal drum along Z: steel cylinder ~0.66 m dia × ~0.62 m long, darker end caps, 3–4 raised copper coil bands
around the middle, a short steel shaft sticking out of the FRONT (+Z) end with a brass collar, a small yellow lightning-bolt
plate on each side, all on a soft green base plate with two feet. The base's underside sits at y = −0.45 (the tower top is at −0.5).

## 2. part-blades (the rotor, mounted on the front face of the hub block, which ends at z = −0.5 of this cell)
- A round grey hub (~0.4 m dia) centred at (0, 0, −0.25) with a small blue rounded nose cone pointing +Z.
- THREE long white tapered blades (each ~2.5 m from hub centre to tip, ~0.26 m wide at the root, narrowing to ~0.12 m,
  slightly twisted/pitched like a real blade), 120° apart, in the X–Y plane (the rotor disc faces +Z). These may extend
  beyond the cell — that is intended (rotor diameter ~5.2 m).
- Put the hub, nose and blades under ONE child node named exactly `spin`, whose origin is the rotor axis at (0, 0, −0.25),
  so the game can rotate `spin` around its local Z axis. Nothing else may be under the root besides `spin`.

## 3. part-wire-terminal (sits on top of the foundation, beside the tower; floor at y = −0.5)
A small rounded navy box ~0.52 × 0.36 × 0.42 m resting on y = −0.5, two copper hex nuts + posts on top with a RED cap
(left, −X) and a BLACK cap (right, +X), and a short copper cable coil coming out of the +X side.

When done, reply with the list of files written and the triangle counts. Do not modify anything outside this folder.
