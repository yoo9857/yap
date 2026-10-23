# Furniture — how it works and how to add a piece

Furniture is Craft Island's and the education field's decorating system: about
fifty pieces in seven categories, free and unlimited, placed with the mouse or
entirely from the keyboard. This page is the operating standard. Keep it true
when you change anything under `apps/client/src/craft/furniture/` or
`packages/shared/src/furniture/`. The catalog, types, geometry and layout rules
live in the shared package; the original client paths re-export them for compatibility.

## Layout of the code

```
craft/furniture/
  types.ts         data model (FurnitureDef, PartSpec, Palette, PlacedFurniture)
  catalog/
    kit.ts         authoring kit: brick(), ball(), legs4(), wallFrame(), palettes(), colour set C
    living.ts …    one file per category, plain data
    index.ts       CATEGORIES, CATALOG, lookups, search
  footprint.ts     pure geometry: cells, rotation, model centre, bounds, ray test
  layout.ts        pure rules: what may go where, support, cascades, save format
  model.ts         def + colour → one merged vertex-coloured geometry   (three.js)
  view.ts          one InstancedMesh per (kind, colour) in use, ghost      (three.js)
  shop.ts/.css     chip, catalog panel, furniture bar                       (DOM)
  controller.ts    mode, keys, aiming, placing, putting away — the only part
                   CraftGame talks to
```

Dependencies only point downward: `types` ← `catalog` ← `footprint`/`layout`
(pure, unit-tested without a browser) ← `model`/`view`/`shop` ← `controller` ←
`craftGame.ts`. Nothing pure may import three.js or touch the DOM.

## Adding a piece

1. Pick the category file in `packages/shared/src/furniture/catalog/`. A category holds **at most nine**
   pieces (the bar is driven by the 1‒9 keys); a tenth means a new category in
   `catalog/index.ts`, not a bigger one.
2. Append a `FurnitureDef`. The `key` is **persisted in saves**: kebab-case,
   unique, and never renamed or reused afterwards.
3. Describe the model as parts with the kit (`brick`, `ball`, `legs4`, …) in
   the conventions below, using the shared colours `C.*` where you can.
4. Run `npx vitest run test/furniture-catalog.test.ts` (from `apps/client`).
   It rejects a model that leaves its cells, floats, names a colour slot a
   palette lacks, or breaks a placement rule. It has caught real mistakes:
   a dresser floating 4 cm, a faucet (twice) and a barbecue lid sticking into
   the cell above, a picnic table's tilted legs sinking into the floor.
5. Look at it: `node tools/shot-furniture.mjs <outdir> <category|kind>` with
   `pnpm dev` running. It photographs every piece alone, close up from a
   three-quarter angle, and stitches one contact sheet per category. The test
   proves the piece fits; only a picture proves it reads as what it is.

### Model conventions

All coordinates are metres in the piece's own space, **front facing +z**,
centred on the footprint (a piece `w` cells wide spans x ∈ ±w/2).

| placement | floor of the model                     | notes                                                                            |
|-----------|----------------------------------------|----------------------------------------------------------------------------------|
| `floor`   | y = 0 is the top of the block below    | Fills its `w×d×h` cells **solidly**. Optional `surface` = height of its top.     |
| `rug`     | y = 0, exactly `RUG_TOP` (0.14 m) thick | One layer, walked over; floor pieces stand on it.                               |
| `surface` | y = 0 is where it stands               | 1×1×1 only. Stands on a host's `surface` height, a rug, or bare ground.          |
| `wall`    | back at z = −0.5 (the wall face)       | `d` = 1; `w` cells along the wall, `h` up. Hung on the side face that was hit.   |

Parts (build them with the kit, `catalog/kit.ts`):

| part    | kit         | for                                                                      |
|---------|-------------|--------------------------------------------------------------------------|
| `box`   | `brick()`   | most things; `soft` = corner radius as a fraction of the smallest extent |
| `ball`  | `ball()`    | faces, leaves, bulbs, puffy cushions                                     |
| `cyl`   | `cyl()`     | poles, pots, discs; `taper` < 1 narrows up (lampshade, an OPEN parasol, a cone at 0), > 1 widens up (bowl, basin) |
| `dome`  | `dome()`    | half-ellipsoid on a closed base: canopies, kettle lids                    |
| any     | `rot`       | Euler radians about the part's centre (three's XYZ order): a clock face is a `cyl` turned `[QUARTER, 0, 0]`, a roof slab is a tilted `brick` |
| several | `hollow()`  | something you look INTO — tub, basin, planter: floor + four walls around an open top, inside in its own colour |

Solid shapes cannot be carved, so depth is built, never painted: a tub is
`hollow()` with the water set well below its rim; a sink is a worktop of four
strips around a hole with the basin sitting in it; a fireplace is two piers and
a lintel around a dark firebox. A flat lid with a blue rectangle on it reads as
a lid, not as a tub.

The box and ball are the creatures' own geometry (`player/blockParts.ts`), so
furniture and pets read as one toy set.

**Thin things on the floor must be at least `RUG_TOP` (0.14 m) thick.** The
floor bricks' studs stand 10 cm above the cell floor; a 6 cm rug or shower
tray has them poking through.

### Colour variants

`palettes` lists variants; a part's `color` is either a literal `0xRRGGBB` or a
slot name every palette defines (`palettes(["main", "accent"], [["파랑", …], …])`).
The variant **index** is persisted, so only ever **append** palettes. The first
slot's colour is the swatch the panel shows. Sets that should match (sofa and
armchair, both beds) share one palette constant.

Lights are colours, not light sources: real lights per piece would cost a
shader recompile and a frame of lighting per lamp.

## Doors, gates and curtains

A def with `openParts` opens and closes: a right click ON the piece toggles it
in any mode (holding blocks or furniture), and middle-click on any piece picks
its kind and colour. An open floor piece is not solid (`occupied` skips it),
closing is refused while the player stands in its cells, and `state: 1` is
saved as a seventh tuple entry only for open pieces. Doors hang in the BACK
plane of their cell and swing toward the front, so the open leaf never leaves
its cell. The open model must stay inside the same cells (the catalog test
bounds both looks).

Aiming uses each part's own box (`rayPiece`), not the piece's overall box: the
ray passes through an open doorway or between a chair's legs, and still lands
on the leaf, the post or the seat.

## Seats, undo, sounds

- A floor def with `seat` (metres) can be sat on: right-click it while not in
  furniture mode. The robot's hips are 0.42 m above its feet, so a seat must be
  higher than that (catalog-tested). While seated the body is held on the seat
  with physics suspended; WASD/space, or the seat being removed, stands it up
  in the cell in front (or on top, if that is blocked).
- Ctrl+Z / Ctrl+Y undo and redo placing and putting away (with whatever went
  along). A step that no longer fits — a block now fills the spot — is refused
  whole, never half-applied. Pieces dropped because their floor was mined are
  not on the undo stack: undoing them would leave a sofa on thin air.
- Furniture has its own synthesized sounds (`audio/sfx.ts`: place, pickup,
  doorOpen, doorClose, sit, undo) — soft and woody, not the block sounds.

## Rules (layout.ts)

A cell holds at most one piece per **layer**, which is how a rug lies under a
sofa, a vase stands on a table and a clock hangs over a bed:

| layer     | from placement | solid to bodies | must find empty in its cells |
|-----------|----------------|-----------------|------------------------------|
| `solid`   | floor          | yes             | solid, surface, wall         |
| `rug`     | rug            | no              | rug                          |
| `surface` | surface        | no              | surface                      |
| `wall`    | wall           | no              | wall, solid                  |

- Placement is all-or-nothing. Floor: every bottom cell on a block, no body in
  the way. Rug/surface: on a block (or, for surface, on a host with a top).
  Wall: a block directly behind every cell.
- Support is "one leg is enough": a piece is put away when the **last** block
  holding it is mined (`afterBlockRemoved`), and removing a piece takes what
  stood on it (`remove` cascades).
- No block may be placed into a cell holding any piece — nor into the cell
  above a raised table-top piece that reaches into it (`blocksBlock`); a tall
  piece is refused on a host with a block right above it.

## Integration points

- **Collision** goes through `VoxelWorld.propSolid` → `isBlocked`, used by
  `voxelBody` and `raycast(..., true)`. **`isSolid` must stay furniture-free**:
  the chunk renderer culls faces with it, so a chair beside a wall would punch
  a hole in the wall.
- **Coordinates**: the layout is in ABSOLUTE cells. The field scrolls its grid
  under the player, so the controller converts with the window origin, and a
  scroll never touches the layout.
- **Aiming**: solid pieces are in the voxel ray; rugs, surface and wall pieces
  are tested against their model box (`placedBounds` + `rayBox`). The nearer
  hit wins, so a vase on a table is picked before the table.
- **Rendering cost** is one draw call per *distinct look* in use, ×3 (scene,
  ink mask, shadow). Measured: 400 chairs added 3 draw calls; 200 sofas in four
  colours added 12.
- **Geometry stays small and indexed** (`model.ts`): boxes use 1–2 corner
  segments (not the creatures' 4), and `RoundedBoxGeometry`'s un-indexed
  output is welded back with `mergeVertices`. Un-indexed 4-segment bricks were
  ~2 900 vertices each — a bookshelf ~175k, a curtain ~50k — and placing or
  first seeing one dropped frames. Now all 53 default looks total ~83k.
  Default looks are pre-built in idle slices after boot (`prebuild`).
- **Colours reuse the shape**: `buildFurnitureShape` is built once per kind
  (+ open), and each colour is `paintFurniture` — a geometry that SHARES the
  shape's index/position/normal/uv and owns only a colour buffer. So never
  dispose one look alone (it would free its siblings' buffers); the view
  disposes them all together. Pinned by `test/furniture-model.test.ts`.
- **No shader compiles mid-game**: the boot warm-up (`setWarm`) draws one real
  instance, the furniture ghost and the block-cell highlight far below the
  world (all three `frustumCulled = false` for that reason). Measured with a
  program-count probe over placing every kind: zero new programs.
- **The placement ghost** is drawn 1.2 % larger with `polygonOffset` and is
  hidden on the spot you just placed on until the aim moves: a translucent red
  copy in the same surfaces as the piece z-fought into a shimmering glow.
- **Saves**: `[kind, x, y, z, rot, variant]` per piece in both the island and the
  field save. Entries are validated one by one; a bad entry is dropped, an
  unknown colour falls back to variant 0, five-element tuples (pre-variant
  saves) read as variant 0.

## Classrooms

Teachers and students use the same furniture tools. `k-furniture` sends an atomic
placement/removal transaction in absolute coordinates, including colour and door
state. The server validates it with the same shared layout rules, checks every
participant's body, and broadcasts `s-k-furniture` with the authoritative layout.
Conflicts and locked student edits restore that layout on the sender. Block edits
are flushed before furniture operations so a newly built support already exists.

Furniture is saved beside the field diff in the class store. Welcome/reconnect
snapshots include all furniture; resetting the field clears it. Removing supports
cascades on the server, and blocks cannot be built through furniture. Student
building locks also cover placement, pickup, undo/redo and door toggles. Classroom
protocol version 2 requires a page refresh for clients from before this change.
Unchanged pieces keep their object identity when snapshots arrive so another
participant's edit doesn't make a seated player stand up.

## Remaining limitations

- Machines collide with solid furniture as whole cells (the terrain bake uses
  `isBlocked`), not with the model's shape.
- No "recently used" row, no cost/inventory — all furniture is free.
