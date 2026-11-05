# CraftYap block studs: Blender source -> one GLB that the web game (three.js) and the native
# client (Rust/wgpu) both read. See assets/blocks/studs/README_KO.md.
#
#   blender --background --factory-startup --python-exit-code 1 \
#           --python assets/blocks/studs/source/build_block_studs.py -- <BlockForm.blend|BlockStuds.blend> assets/blocks/studs
#
# From BlockForm.blend (the approved soft block form, CraftYap_soft_block_form 2026-10-29) it lifts
# the four closed studs off the final block "Soft continuous shell and low closed connectors" and
# writes source/BlockStuds.blend (the editable source from then on) and runtime/block-studs.glb. Given BlockStuds.blend
# it only re-exports, so hand edits there are kept.
#
# Two meshes, both a whole 1 m top (four studs on 0.5 m sub-cells), origin at the centre of the
# brick's top face, metres, +Y up in the GLB:
#   Stud_HQ   - the original, untouched: 16 segments, the 5-level profile (h 0/.004/.03/.037/.04 m,
#               r .098/.1/.1/.094/.086 m). Drawn near the player.
#   Stud_LOD1 - the same profile without the two sub-centimetre bevel rings, at 8 segments. Drawn
#               from 12 m out, where a bevel ring is under a pixel and an 8-gon of a 20 cm stud
#               deviates from the circle by ~0.6 px.
# Neither has a bottom cap: it lies on the brick top and is never seen. Sharp edge between each
# flat top and its bevel, smooth walls (as kitShell.ts kitConnectorGeometry shades them).
import bpy, bmesh, sys, math, os, json, hashlib
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(args) != 2:
    raise SystemExit("usage: ... -- <BlockForm.blend|BlockStuds.blend> <out dir>")
src, out = os.path.abspath(args[0]), os.path.abspath(args[1])
for sub in ("source", "runtime"):
    os.makedirs(os.path.join(out, sub), exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=src)

SOURCE_OBJECT = "Soft continuous shell and low closed connectors"
OFFSETS = [(-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)]
LOD_SEGMENTS = 8


def sharpen_tops(me):
    """Smooth walls, a hard edge round every flat top."""
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        tops = [f for f in e.link_faces if f.normal.z > 0.999]
        e.smooth = not (tops and len(tops) < len(e.link_faces))
    bm.to_mesh(me)
    bm.free()


def lift_hq():
    """The original studs, cut out of the approved block, in cell-top coordinates (Blender Z up)."""
    obj = next(o for o in bpy.data.objects if o.name.startswith(SOURCE_OBJECT))
    ws = [obj.matrix_world @ v.co for v in obj.data.vertices]
    lo = Vector((min(v.x for v in ws), min(v.y for v in ws), min(v.z for v in ws)))
    hi = Vector((max(v.x for v in ws), max(v.y for v in ws), max(v.z for v in ws)))
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, hi.z - 0.04))  # the top face's centre
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    bm.verts.ensure_lookup_table()
    # keep the stud faces: everything standing above the top face (its flat cap and the shell are below)
    drop = [f for f in bm.faces if f.calc_center_median().z <= centre.z + 1e-5]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bmesh.ops.translate(bm, verts=bm.verts, vec=-centre)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    me = bpy.data.meshes.new("Stud_HQ")
    bm.to_mesh(me)
    bm.free()
    for attr in list(me.color_attributes):
        me.color_attributes.remove(attr)  # the brick's own colour/material tints the studs
    sharpen_tops(me)
    return me, obj.name


def profile_of(me):
    """(height, radius) per ring of the first stud, measured from the mesh."""
    rings = {}
    ox, oy = OFFSETS[0]
    for v in me.vertices:
        if v.co.x < 0 and v.co.y < 0:
            h = round(v.co.z, 4)
            rings.setdefault(h, []).append(math.hypot(v.co.x - ox, v.co.y - oy))
    return [(h, sum(r) / len(r)) for h, r in sorted(rings.items())]


def build_lod(profile):
    """Stud_LOD1: the measured profile minus its sub-centimetre bevel rings, at LOD_SEGMENTS."""
    # the straight wall at its full radius from the base to its top, then the top cap's rim
    r_wall = max(r for _, r in profile)
    h_wall = max(h for h, r in profile if r >= r_wall - 1e-4)
    keep = [(profile[0][0], r_wall), (h_wall, r_wall), profile[-1]]
    bm = bmesh.new()
    for ox, oy in OFFSETS:
        rings = []
        for h, r in keep:
            rings.append([bm.verts.new((ox + math.cos(i * math.tau / LOD_SEGMENTS) * r, oy + math.sin(i * math.tau / LOD_SEGMENTS) * r, h)) for i in range(LOD_SEGMENTS)])
        for a, b in zip(rings, rings[1:]):
            for i in range(LOD_SEGMENTS):
                j = (i + 1) % LOD_SEGMENTS
                bm.faces.new((a[i], a[j], b[j], b[i]))
        bm.faces.new(rings[-1])
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("Stud_LOD1")
    bm.to_mesh(me)
    bm.free()
    sharpen_tops(me)
    return me, keep


def planar_uv(me):
    """The brick top's tile, planar (game uv = x + 0.5, -z - 0.5 = Blender x + 0.5, y - 0.5)."""
    uv = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (co.x + 0.5, co.y + 0.5)


studs_blend = os.path.join(out, "source", "BlockStuds.blend")
if "Stud_HQ" in bpy.data.objects:  # re-export of the editable source
    hq_obj, lod_obj = bpy.data.objects["Stud_HQ"], bpy.data.objects["Stud_LOD1"]
    lifted_from, kept = "BlockStuds.blend", None
else:
    hq, lifted_from = lift_hq()
    lod, kept = build_lod(profile_of(hq))
    for me in (hq, lod):
        planar_uv(me)
    # a lean file: only the studs (the source block also holds fracture shards, cards, textures)
    for me in (hq, lod):
        me.use_fake_user = True  # survive the purge
    bpy.data.batch_remove(list(bpy.data.objects) + list(bpy.data.collections))
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    for me in (hq, lod):
        me.use_fake_user = False
    col = bpy.data.collections.new("Block studs")
    bpy.context.scene.collection.children.link(col)
    hq_obj, lod_obj = bpy.data.objects.new("Stud_HQ", hq), bpy.data.objects.new("Stud_LOD1", lod)
    for o in (hq_obj, lod_obj):
        col.objects.link(o)
    lod_obj.location.x = 1.5  # side by side in the .blend; the export zeroes it
    bpy.ops.wm.save_as_mainfile(filepath=studs_blend)

# export each mesh at the origin
saved = lod_obj.location.copy()
lod_obj.location = (0, 0, 0)
for o in bpy.data.objects:
    o.select_set(o.name in ("Stud_HQ", "Stud_LOD1"))
glb = os.path.join(out, "runtime", "block-studs.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_normals=True,
                          export_texcoords=True, export_materials="NONE", export_vertex_color="NONE", export_apply=True)
lod_obj.location = saved


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


data = open(glb, "rb").read()
manifest_path = os.path.join(out, "runtime", "manifest.json")
previous = json.load(open(manifest_path, encoding="utf-8")) if os.path.exists(manifest_path) else {}
if kept is None:  # a re-export: keep where the studs came from and the LOD's profile
    lifted = (previous.get("liftedFrom"), previous.get("liftedFromSha256"))
    kept = previous.get("meshes", {}).get("Stud_LOD1", {}).get("profile")
else:
    lifted = (f"{os.path.basename(src)} / {lifted_from}", hashlib.sha256(open(src, "rb").read()).hexdigest())
manifest = {
    "version": 1,
    "provenance": "Original Blender block form (CraftYap_soft_block_form, 2026-10-29): the final block's four closed studs",
    "source": "assets/blocks/studs/source/BlockStuds.blend",
    "liftedFrom": lifted[0],
    "liftedFromSha256": lifted[1],
    "units": "metres",
    "up": "+Y",
    "origin": "centre of the brick's top face",
    "meshes": {
        "Stud_HQ": {"triangles": tris(hq_obj), "use": "within lodDistance of the focus"},
        "Stud_LOD1": {"triangles": tris(lod_obj), "segments": LOD_SEGMENTS, "profile": kept, "use": "lodDistance .. studRange"},
    },
    "lodDistance": 12,
    "studRange": 32,
    "file": {"name": "block-studs.glb", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()},
}
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print("STUDS", json.dumps(manifest["meshes"]))
