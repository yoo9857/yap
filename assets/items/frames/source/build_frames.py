"""Build CraftYap's seven metre-cell turbine frames in Blender, then export and render.

Run: blender --background --factory-startup --python-exit-code 1 --python source/build_frames.py
Coordinates in the modelling helpers are GAME coordinates: X right, Y up, Z front.
The conversion to Blender's Z-up system is baked into mesh vertices. glTF exports
convert them back to Y-up; every runtime root and mesh has an identity transform.
No downloaded assets, textures, or dependencies. The three supplied parts are
imported from the parts runtime directory, including the blades' original -0.25 m spin-node offset.
"""

import json
import math
import struct
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[1]
SOURCE, RUNTIME, PREVIEWS = (ROOT / p for p in ("source", "runtime", "previews"))
for directory in (SOURCE, RUNTIME, PREVIEWS):
    directory.mkdir(parents=True, exist_ok=True)

KEYS = ["frame-foundation", "frame-foundation-center", "frame-tower-base",
        "frame-tower", "frame-tower-top", "frame-nacelle-tail", "frame-hub"]
PALETTE = {
    "concrete": ("C9CDD3", .02, .46),
    "concrete_dark": ("A9AFB8", .02, .46),
    "tower": ("F2F4F7", .03, .35),
    "steel": ("AEB8C2", .18, .40),
    "dark_steel": ("7F8994", .18, .43),
    "door": ("4A6496", .02, .44),
    "nacelle": ("F4F6F8", .03, .34),
    "yellow": ("FFCF3A", .02, .35),
    "bolts": ("8E98A3", .18, .40),
    "window": ("6FA8E8", .08, .32),
}


def linear(v):
    return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4


def color(hex_string):
    return tuple(linear(int(hex_string[i:i+2], 16) / 255) for i in (0, 2, 4)) + (1,)


def xyz(p):
    return (p[0], -p[2], p[1])


def new_collection(name, scene=None):
    collection = bpy.data.collections.new(name)
    (scene or bpy.context.scene).collection.children.link(collection)
    return collection


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.name = "Turbine | assembled"
ASSEMBLY_SCENE = bpy.context.scene
ASSETS = new_collection("FRAME ASSETS | cell-centred masters")
ASSEMBLED = new_collection("ASSEMBLED | exact blueprint cells")
STUDIO = new_collection("STUDIO | preview only")
MATERIALS = {}
for key, (hex_string, metallic, roughness) in PALETTE.items():
    mat = bpy.data.materials.new(f"{key} #{hex_string}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color(hex_string)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = color(hex_string)
    MATERIALS[key] = mat

BUDGETS = {key: 1500 for key in KEYS}
BUDGETS.update({"frame-foundation-center":2000,"frame-tower-base":2500})
ACTIVE_ROOT = None
PARTS = {}


def start(key):
    global ACTIVE_ROOT
    obj = bpy.data.objects.new(key, None)
    ASSETS.objects.link(obj)
    obj.empty_display_type = 'CUBE'
    obj.empty_display_size = .5
    obj["cell_size_m"] = 1.0
    obj["front"] = "+Z (glTF / game)"
    obj["up"] = "+Y (glTF / game)"
    obj["purpose"] = "Modular turbine building frame"
    ACTIVE_ROOT = obj
    PARTS[key] = obj
    return obj


def mesh(name, vertices, faces, material="tower", face_mats=None, smooth=True):
    data = bpy.data.meshes.new(name + "_geometry")
    data.from_pydata([xyz(v) for v in vertices], [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    ASSETS.objects.link(obj)
    obj.parent = ACTIVE_ROOT
    material_keys = [material] if isinstance(material, str) else material
    for key in material_keys:
        data.materials.append(MATERIALS[key])
    for index, polygon in enumerate(data.polygons):
        polygon.use_smooth = smooth and len(polygon.vertices) == 4
        if face_mats:
            polygon.material_index = face_mats[index]
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(data)
    bm.free()
    return obj


def profile(name, rings, material="tower", axis="y", center=(0, 0, 0), n=40,
            caps=True, bands=None):
    """Turn (axial position, radius) rings; no modifier or hidden subdivision."""
    vertices = []
    for height, radius in rings:
        for j in range(n):
            a = math.tau * j / n
            p = (radius * math.cos(a), height, radius * math.sin(a)) if axis == "y" else (
                radius * math.cos(a), radius * math.sin(a), height)
            vertices.append(tuple(p[k] + center[k] for k in range(3)))
    faces, mids = [], []
    for i in range(len(rings) - 1):
        for j in range(n):
            faces.append((i*n+j, i*n+(j+1)%n, (i+1)*n+(j+1)%n, (i+1)*n+j))
            mids.append(bands[i] if bands else 0)
    if caps:
        faces += [tuple(reversed(range(n))), tuple((len(rings)-1)*n+j for j in range(n))]
        mids += [0, 0]
    return mesh(name, vertices, faces, material, mids)


def rounded_box(name, center, size, material, bevel=.025, segments=2):
    x, y, z = (s / 2 for s in size)
    vertices = [(sx*x+center[0], sy*y+center[1], sz*z+center[2])
                for sx, sy, sz in [(-1,-1,-1), (-1,-1,1), (-1,1,-1), (-1,1,1),
                                  (1,-1,-1), (1,-1,1), (1,1,-1), (1,1,1)]]
    obj = mesh(name, vertices, [(0,4,6,2),(1,3,7,5),(0,1,5,4),
                              (2,6,7,3),(0,2,3,1),(4,5,7,6)], material)
    bpy.context.view_layer.objects.active = obj
    bevel_mod = obj.modifiers.new("Soft moulded edges", 'BEVEL')
    bevel_mod.width = min(bevel,min(size)*.45)
    bevel_mod.segments = segments
    bevel_mod.affect = 'EDGES'
    bpy.ops.object.modifier_apply(modifier=bevel_mod.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    normal = obj.modifiers.new("Satin face normals", 'WEIGHTED_NORMAL')
    normal.keep_sharp = True
    normal.weight = 30
    bpy.ops.object.modifier_apply(modifier=normal.name)
    return obj


def rectangle_loop(width, height, radius, n=4):
    result = []
    for cx, cy, start_angle in [(width/2-radius, height/2-radius, 0),
                               (-width/2+radius, height/2-radius, 90),
                               (-width/2+radius, -height/2+radius, 180),
                               (width/2-radius, -height/2+radius, 270)]:
        for i in range(n+1):
            a = math.radians(start_angle + i * 90/n)
            result.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return result


def shell(name, sections, inner, material="nacelle", stripe_band=None):
    """Watertight wall thickness, with a genuine uncapped opening at one end.

    sections = (Z, width, height, corner radius, Y centre), back to front.
    Inner sections run from the opening back into the cavity.
    """
    vertices, faces, mids = [], [], []
    n = 20
    for z, w, h, r, cy in sections + inner:
        vertices += [(x, y+cy, z) for x,y in rectangle_loop(w,h,r)]
    for i in range(len(sections)-1):
        for j in range(n):
            faces.append((i*n+j, i*n+(j+1)%n, (i+1)*n+(j+1)%n, (i+1)*n+j))
            mids.append(1 if stripe_band is not None and i == stripe_band else 0)
    # The first outer section is a closed, rounded back; front remains hollow.
    faces.append(tuple(reversed(range(n))))
    mids.append(0)
    opening = (len(sections)-1)*n
    cavity = len(sections)*n
    for j in range(n):
        faces.append((opening+j, opening+(j+1)%n, cavity+(j+1)%n, cavity+j))
        mids.append(0)
    for i in range(len(sections), len(sections)+len(inner)-1):
        for j in range(n):
            faces.append((i*n+j, i*n+(j+1)%n, (i+1)*n+(j+1)%n, (i+1)*n+j))
            mids.append(2)
    faces.append(tuple((len(sections)+len(inner)-1)*n+j for j in range(n)))
    mids.append(2)
    return mesh(name, vertices, faces, [material,"yellow","steel"], mids)


def foundation(center=False):
    start('frame-foundation-center' if center else 'frame-foundation')
    n=16
    loops=[]
    # Flat vertical sides are exactly +/-0.5. A fine metal course and lower
    # skirt are part of the pad surface, with no coincident overlay faces.
    levels=[(-.5,.5),(-.30,.5),(.378,.5),(.401,.5),(.420,.5),
            (.462,.5),(.490,.478),(.492,.458),(.492,.420),(.481,.411),(.481,.397)]
    for y,half in levels:
        loops.append([(half*math.cos(math.tau*j/n)/max(abs(math.cos(math.tau*j/n)),abs(math.sin(math.tau*j/n))),
                       y,half*math.sin(math.tau*j/n)/max(abs(math.cos(math.tau*j/n)),abs(math.sin(math.tau*j/n))))
                      for j in range(n)])
    mids_for_spans=[1,0,2,2,0,0,0,0,1,1]
    if center:
        loops += [[(.394*math.cos(math.tau*j/n),.408,.394*math.sin(math.tau*j/n)) for j in range(n)]]
        mids_for_spans += [0]
    else:
        loops += [[(x,.494,z) for x,y,z in loops[-1]]]
        mids_for_spans += [0]
    faces=[]; mids=[]
    for i in range(len(loops)-1):
        for j in range(n):
            faces.append((i*n+j,i*n+(j+1)%n,(i+1)*n+(j+1)%n,(i+1)*n+j))
            mids.append(mids_for_spans[i])
    faces += [tuple(reversed(range(n))),tuple((len(loops)-1)*n+j for j in range(n))]
    mids += [1,0]
    mesh('chamfered_concrete_pad_recess_trim_and_skirt',[v for ring in loops for v in ring],
         faces,['concrete','concrete_dark','steel'],mids,False)
    for i,(x,z) in enumerate([(-.439,-.439),(-.439,.439),(.439,-.439),(.439,.439)],1):
        profile(f'corner_fastener_{i}',[(.492,.019),(.497,.019),(.5,.014)],'bolts',center=(x,0,z),n=6)
    if center:
        profile('raised_concrete_round_plinth',[(.408,.379),(.427,.406),(.464,.406),(.480,.390)],
                'concrete_dark',n=32)
        # Twelve anchor heads sit in the ring at its flush Y=+0.5 top.
        profile('steel_tower_anchor_ring',[(.456,.482),(.468,.493),(.485,.493),(.493,.484),
                (.493,.427),(.5,.421),(.5,.405),(.476,.400)],'steel',n=40)
        for i in range(12):
            a=math.tau*(i+.5)/12
            profile(f'anchor_bolt_{i+1:02d}',[(.487,.019),(.497,.019),(.5,.014)],
                    'bolts',center=(.472*math.cos(a),0,.472*math.sin(a)),n=6)


def curved_door(name,width,height,corner,cy,back_r,front_r,material):
    # A grid follows the cylinder at EVERY vertex. A single polygon/fan on a
    # tall curved panel cuts through the tower and creates white hourglass gaps.
    ys=[-height/2+corner*(1-math.cos(i*math.pi/4)) for i in range(3)]
    ys += [-y for y in reversed(ys)]
    cols=8
    verts=[]
    flare=[(-1,.450),(-.986,.475),(-.947,.475),(-.922,.455),(-.858,.403),(-.823,.390),(1,.390)]
    def added_flare(y):
        for (ya,ra),(yb,rb) in zip(flare,flare[1:]):
            if ya<=y<=yb:
                return max(0,ra+(rb-ra)*(y-ya)/(yb-ya)-.390)
        return 0
    for radius in (back_r,front_r):
        for y in ys:
            d=max(0,abs(y)-(height/2-corner))
            half=width/2-corner+math.sqrt(max(0,corner*corner-d*d))
            r=radius+added_flare(y+cy)
            for j in range(cols+1):
                x=half*(2*j/cols-1)
                verts.append((x,y+cy,math.sqrt(r*r-x*x)))
    stride=cols+1
    layer=len(ys)*stride
    faces=[]
    for side in range(2):
        for i in range(len(ys)-1):
            for j in range(cols):
                q=side*layer+i*stride+j
                faces.append((q,q+1,q+1+stride,q+stride))
    perimeter=list(range(stride))+[i*stride+cols for i in range(1,len(ys))]
    perimeter += [(len(ys)-1)*stride+j for j in range(cols-1,-1,-1)]
    perimeter += [i*stride for i in range(len(ys)-2,0,-1)]
    for i,a in enumerate(perimeter):
        b=perimeter[(i+1)%len(perimeter)]
        faces.append((a,b,b+layer,a+layer))
    return mesh(name,verts,faces,material)


foundation(False)
foundation(True)

start('frame-tower-base')
ACTIVE_ROOT['cell_span_xyz']=[1,2,1]
ACTIVE_ROOT['origin_note']='Centre of the two occupied cells; Y -1 to +1'
ACTIVE_ROOT['door_width_height_m']=[.55,1.70]
profile('two_cell_white_tower_and_flared_flange',
        [(-1,.450),(-.986,.475),(-.947,.475),(-.922,.455),(-.858,.403),
         (-.823,.390),(-.786,.390),(-.758,.390),(1,.390)],
        ['tower','steel','yellow'],bands=[1,1,1,0,0,0,2,0])
curved_door('door_dark_recess_surround',.592,1.748,.095,-.06,.389,.399,'dark_steel')
curved_door('robot_height_navy_access_door',.55,1.70,.080,-.06,.399,.409,'door')
curved_door('small_window_steel_frame',.245,.232,.047,.475,.409,.419,'steel')
curved_door('small_blue_window',.204,.190,.036,.475,.419,.423,'window')
rounded_box('door_pull_handle',(.169,-.175,.393),(.029,.170,.035),'steel',.012,2)
rounded_box('steel_entry_step',(0,-.955,.415),(.56,.065,.17),'steel',.020,2)
# The step ends at +Z=.5; it stays inside the 1x2x1 volume.
for i in range(3):
    rounded_box(f'step_grip_{i+1}',(0,-.920,.365+i*.040),(.410,.007,.010),'dark_steel',.003,1)
rounded_box('door_lamp_steel_hood',(0,.894,.399),(.235,.110,.105),'steel',.025,2)
rounded_box('door_lamp_warm_diffuser',(0,.877,.452),(.172,.049,.018),'yellow',.012,2)

start("frame-tower")
profile("continuous_white_tube_and_top_flange",[(-.5,.390),(.425,.390),
        (.442,.412),(.481,.412),(.5,.390)], ["tower","steel"],bands=[0,1,1,1])

start("frame-tower-top")
profile("tapered_white_tube",[(-.5,.390),(.29,.360),(.327,.360),(.342,.390)],"tower")
profile("steel_yaw_turntable",[(.325,.385),(.341,.427),(.389,.427),
        (.399,.408),(.418,.408),(.429,.427),(.481,.427),(.5,.409)],
        ["steel","dark_steel"],bands=[0,0,0,1,1,0,0])

start("frame-nacelle-tail")
tail_sections = [(-.5,.57,.54,.17,-.045),(-.473,.68,.63,.18,-.045),
                 (-.405,.80,.70,.17,-.025),(-.280,.88,.76,.16,-.005),
                 (.413,.90,.83,.14,.025),(.440,.90,.83,.14,.025),(.5,.90,.83,.14,.025)]
tail_inner = [(.5,.824,.754,.112,.025),(-.250,.802,.685,.13,-.008),
              (-.388,.68,.575,.135,-.025)]
shell("tail_shell_open_front",tail_sections,tail_inner,stripe_band=4)
rounded_box("tail_mounting_keel",(0,-.440,.12),(.50,.12,.74),"steel",.025,2)
for side in (-1,1):
    for i,z in enumerate((-.075,.045,.165)):
        rounded_box(f"side_vent_{'L' if side < 0 else 'R'}_{i+1}",
                    (side*.446,.078,z),(.014,.150,.036),"dark_steel",.006,1)
profile("wind_vane_mast",[(.348,.012),(.471,.012),(.481,.009)],
        "steel",center=(0,0,-.248),n=10)
rounded_box("wind_vane_crossarm",(0,.473,-.250),(.019,.018,.295),"dark_steel",.007,1)
mesh("wind_vane_tail_fin",[(-.008,.449,-.373),(-.008,.495,-.373),(-.008,.473,-.289),
                           (.008,.449,-.373),(.008,.495,-.373),(.008,.473,-.289)],
     [(0,2,1),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)],"yellow")
profile("wind_vane_nose",[(-.118,.012),(-.096,.006)],"steel",axis="z",center=(0,.473,0),n=8)

start("frame-hub")
# Build the open shell from the closed nose backwards; the genuine opening is -Z.
hub_sections = [(.388,.475,.475,.235,.025),(.325,.64,.59,.235,.025),
                (.180,.83,.76,.195,.025),(-.100,.90,.83,.14,.025),
                (-.435,.90,.83,.14,.025),(-.462,.90,.83,.14,.025),(-.5,.90,.83,.14,.025)]
hub_inner = [(-.5,.824,.754,.112,.025),(-.120,.824,.754,.112,.025),
             (.155,.740,.675,.17,.025),(.260,.520,.480,.20,.025)]
shell("rotor_housing_open_back",hub_sections,hub_inner,stripe_band=4)
rounded_box("hub_mounting_keel",(0,-.440,-.10),(.50,.12,.78),"steel",.025,2)
profile("rotor_mount_flange",[(.378,.217),(.405,.245),(.477,.245),(.5,.222),
                             (.5,.213),(.486,.207)],
        "steel",axis="z",center=(0,.025,0),n=32)
for i in range(6):
    a = math.tau * (i+.5) / 6
    profile(f"rotor_flange_bolt_{i+1:02d}",[(.485,.021),(.497,.021),(.5,.016)],
            "bolts",axis="z",center=(.182*math.cos(a),.025+.182*math.sin(a),0),n=6)
profile("rotor_shaft_socket",[(.485,.086),(.491,.086),(.5,.077)],"dark_steel",axis="z",center=(0,.025,0),n=24)


def descendants(root):
    return [root] + list(root.children_recursive)


def count_triangles(objects):
    total = 0
    for obj in objects:
        if obj.type == 'MESH':
            obj.data.calc_loop_triangles()
            total += len(obj.data.loop_triangles)
    return total


def bounds(objects):
    points = []
    for obj in objects:
        if obj.type == 'MESH':
            for v in obj.data.vertices:
                p = obj.matrix_world @ v.co
                points.append((p.x,p.z,-p.y))
    return {"min": [round(min(p[i] for p in points),6) for i in range(3)],
            "max": [round(max(p[i] for p in points),6) for i in range(3)]}


def read_glb(path):
    data = path.read_bytes()
    length, kind = struct.unpack_from('<II',data,12)
    return json.loads(data[20:20+length])


def check_meshes(objects):
    non_manifold = 0
    for obj in objects:
        if obj.type != 'MESH':
            continue
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        non_manifold += sum(not edge.is_manifold for edge in bm.edges)
        assert all(f.calc_area()>1e-10 for f in bm.faces), obj.name
        assert bm.calc_volume(signed=True)>0, obj.name
        bm.free()
        assert obj.matrix_basis == Matrix.Identity(4), f"Unapplied transform: {obj.name}"
    assert non_manifold == 0, f"Non-manifold edges: {non_manifold}"


bpy.context.view_layer.update()
manifest = {
    "schema_version": 1, "units": "metres", "up_axis": "+Y", "front_axis": "+Z",
    "cell_size_m": 1, "triangle_budgets": BUDGETS,
    "palette_srgb": {k:"#"+v[0] for k,v in PALETTE.items()},
    "files": {},
    "assembly": {"foundation":{"y":0,"x":[-1,0,1],"z":[-1,0,1]},
                 "tower_base":{"occupied_cells":[[0,1,0],[0,2,0]],"origin":[0,1.5,0]},
                 "tower":{"x":0,"z":0,"y":[3,4,5]},"tower_top_cell":[0,6,0],
                 "tail_cell":[0,7,-2],
                 "generator":{"occupied_cells":[[0,7,-1],[0,7,0]],"origin":[0,7,-.5]},
                 "hub_cell":[0,7,1],"blades_cell":[0,7,2],"terminal_cell":[1,1,0]},
    "integration_notes":[
        "Multi-cell origins are the centres of the entire occupied volumes.",
        "All parts in renders come from the sibling parts runtime exports.",
        "Generator base local Y=-0.45, leaving the specified 0.05 m clearance above the yaw bearing.",
        "Blades and unchanged frame pieces retain their original geometry and pivots.",
        "The plain yellow 0.9 x 1.8 x 0.7 m robot scale box is preview-only."]
}

for key in KEYS:
    root = PARTS[key]
    objects = descendants(root)
    check_meshes(objects)
    tris = count_triangles(objects)
    bb = bounds(objects)
    assert tris <= BUDGETS[key], (key,tris)
    limits=[.5,1,.5] if key=='frame-tower-base' else [.5]*3
    assert all(bb['min'][i]>=-limits[i]-1e-6 and bb['max'][i]<=limits[i]+1e-6 for i in range(3)), (key,bb)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    path = RUNTIME / (key + ".glb")
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB',
                             use_selection=True, export_yup=True,
                             export_apply=True, export_materials='EXPORT',
                             export_animations=False, export_extras=True)
    doc = read_glb(path)
    exported_tris = sum(doc['accessors'][p['indices']]['count']//3
                        for m in doc.get('meshes',[]) for p in m['primitives'])
    assert exported_tris == tris, (key,tris,exported_tris)
    scene_nodes = doc['scenes'][doc.get('scene',0)]['nodes']
    assert len(scene_nodes) == 1 and doc['nodes'][scene_nodes[0]]['name'] == key
    assert not doc.get('images') and not doc.get('textures')
    for node in doc['nodes']:
        assert 'matrix' not in node and 'rotation' not in node and 'scale' not in node and 'translation' not in node, node
    manifest["files"][path.name] = {
        "file": "runtime/"+path.name, "root_node": key,
        "triangle_count": tris,"triangle_budget":BUDGETS[key],"bounding_box": bb,
        "cell_span_xyz":[1,2,1] if key=='frame-tower-base' else [1,1,1],
        "node_names": [node['name'] for node in doc['nodes']],
        "mesh_count": len(doc.get('meshes',[])),
        "all_transforms_applied":True,"non_manifold_edges":0,
    }
    print(f"FRAME_EXPORT {key}: {tris} triangles; {bb}",flush=True)

(RUNTIME / "manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")


def duplicate_asset(key, game_pos, collection, suffix, yaw=0):
    root = PARTS[key].copy()
    root.name = key + " | " + suffix
    collection.objects.link(root)
    root.location = xyz(game_pos)
    root.rotation_euler.z = yaw
    for original in PARTS[key].children_recursive:
        obj = original.copy()
        obj.data = original.data
        obj.name = original.name + " | " + suffix
        collection.objects.link(obj)
        obj.parent = root
    return root


for x in (-1,0,1):
    for z in (-1,0,1):
        duplicate_asset("frame-foundation-center" if (x,z)==(0,0) else "frame-foundation",
                        (x,0,z),ASSEMBLED,f"cell {x},0,{z}")
duplicate_asset('frame-tower-base',(0,1.5,0),ASSEMBLED,'cells 0,1,0 + 0,2,0')
for y in (3,4,5):
    duplicate_asset('frame-tower',(0,y,0),ASSEMBLED,f'cell 0,{y},0')
duplicate_asset('frame-tower-top',(0,6,0),ASSEMBLED,'cell 0,6,0')
duplicate_asset('frame-nacelle-tail',(0,7,-2),ASSEMBLED,'cell 0,7,-2')
duplicate_asset('frame-hub',(0,7,1),ASSEMBLED,'cell 0,7,1')
items_root=next(parent for parent in ROOT.parents if parent.name=='items')
parts_runtime=items_root/'parts'/'runtime'
if '--parts-runtime' in sys.argv:
    parts_runtime=Path(sys.argv[sys.argv.index('--parts-runtime')+1])
for filename,cell in [('part-generator.glb',(0,7,-.5)),('part-blades.glb',(0,7,2)),
                      ('part-wire-terminal.glb',(1,1,0))]:
    before=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(parts_runtime/filename))
    imported=set(bpy.data.objects)-before
    for obj in imported:
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        ASSEMBLED.objects.link(obj)
        if obj.parent is None:
            obj.location += Vector(xyz(cell))
            obj['blueprint_origin']=list(cell)
            obj['source_file']=str(parts_runtime/filename)

# Preview-only scale marker: exact robot dimensions, standing on the pad.
ACTIVE_ROOT=None
figure=rounded_box('ROBOT SCALE | 0.9 x 1.8 x 0.7 m',(-.87,1.4,.57),(.9,1.8,.7),'yellow',.075,3)
ASSETS.objects.unlink(figure)
ASSEMBLED.objects.link(figure)
figure['preview_only']=True

ASSETS.hide_render = True
ASSETS.hide_viewport = True


def studio_material(name, hex_string, roughness=.65):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = color(hex_string)
    mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = roughness
    return mat


FLOOR_MAT = studio_material("Preview ground", "EFF2F5")
# A camera-only lift keeps the distant studio floor light without adding fill
# illumination to the assets. Its diffuse component still receives soft shadows.
floor_nodes = FLOOR_MAT.node_tree.nodes
floor_links = FLOOR_MAT.node_tree.links
floor_path = floor_nodes.new('ShaderNodeLightPath')
floor_lift = floor_nodes.new('ShaderNodeMath')
floor_lift.operation = 'MULTIPLY'
floor_lift.inputs[1].default_value = .65
floor_emission = floor_nodes.new('ShaderNodeEmission')
floor_emission.inputs['Color'].default_value = color("EFF2F5")
floor_add = floor_nodes.new('ShaderNodeAddShader')
floor_links.new(floor_path.outputs['Is Camera Ray'],floor_lift.inputs[0])
floor_links.new(floor_lift.outputs[0],floor_emission.inputs['Strength'])
floor_links.new(floor_nodes.get('Principled BSDF').outputs[0],floor_add.inputs[0])
floor_links.new(floor_emission.outputs[0],floor_add.inputs[1])
floor_links.new(floor_add.outputs[0],floor_nodes.get('Material Output').inputs['Surface'])


def look_at(obj, point):
    obj.rotation_euler = (Vector(point)-obj.location).to_track_quat('-Z','Y').to_euler()


def camera(scene, collection, game_pos, target, ortho):
    data = bpy.data.cameras.new(scene.name+" camera")
    obj = bpy.data.objects.new(data.name,data)
    collection.objects.link(obj)
    obj.location = xyz(game_pos)
    look_at(obj,xyz(target))
    data.type = 'ORTHO'
    data.ortho_scale = ortho
    data.lens = 50
    data.clip_end = 200
    scene.camera = obj
    return obj


def light(collection, name, position, target, energy, size, tint=(1,1,1)):
    data = bpy.data.lights.new(name,'AREA')
    data.energy = energy
    data.shape = 'DISK'
    data.size = size
    data.color = tint
    obj = bpy.data.objects.new(name,data)
    collection.objects.link(obj)
    obj.location = xyz(position)
    look_at(obj,xyz(target))


def configure_scene(scene, collection, size, target=(0,3,0), small=False):
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = .025
    scene.render.resolution_x,scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.world = bpy.data.worlds.new(scene.name+" ambient")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.74,.80,.88,1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .22
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = .1
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1
    floor_mesh = bpy.data.meshes.new(scene.name+" floor geometry")
    floor_mesh.from_pydata([(-100,-100,-.505),(100,-100,-.505),(100,100,-.505),(-100,100,-.505)],[],[(0,1,2,3)])
    floor = bpy.data.objects.new(scene.name+" floor",floor_mesh)
    collection.objects.link(floor)
    floor_mesh.materials.append(FLOOR_MAT)
    if small:
        light(collection,"Sheet softbox",(-3,7,5),(0,0,0),1800,9)
        light(collection,"Sheet fill",(5,4,2),(0,0,0),350,8,(.85,.91,1))
    else:
        light(collection,"Large warm key",(-5,13,8),target,1900,8,(1,.94,.87))
        light(collection,"Cool fill",(7,8,5),target,650,7,(.84,.91,1))
        light(collection,"Rim softbox",(1,12,-6),target,1400,6)


configure_scene(ASSEMBLY_SCENE,STUDIO,(1800,2000),target=(0,4.5,0))
assembly_camera = camera(ASSEMBLY_SCENE,STUDIO,(12,11.5,19),(0,4.5,.25),11.9)

SHEET = bpy.data.scenes.new("Frames | seven-piece sheet")
SHEET_PARTS = new_collection("SHEET | frame instances",SHEET)
SHEET_STUDIO = new_collection("SHEET | lights and labels",SHEET)
configure_scene(SHEET,SHEET_STUDIO,(3360,1120),small=True)
sheet_camera = camera(SHEET,SHEET_STUDIO,(0,9,16),(0,0,0),11.1)
for i,key in enumerate(KEYS):
    duplicate_asset(key,((i-3)*1.46,.5 if key=="frame-tower-base" else 0,0),SHEET_PARTS,"sheet",yaw=math.radians(-27))

FONT_PATH = Path("C:/Windows/Fonts/segoeui.ttf")
font = bpy.data.fonts.load(str(FONT_PATH)) if FONT_PATH.exists() else None
text_mat = bpy.data.materials.new("Preview typography")
text_mat.use_nodes = True
nodes = text_mat.node_tree.nodes
nodes.clear()
emission = nodes.new('ShaderNodeEmission')
emission.inputs['Color'].default_value = color("3F4D5C")
emission.inputs['Strength'].default_value = .65
out = nodes.new('ShaderNodeOutputMaterial')
text_mat.node_tree.links.new(emission.outputs[0],out.inputs[0])


def label(text, x, y, size, align='CENTER'):
    data = bpy.data.curves.new(text,'FONT')
    data.body = text
    data.align_x = align
    data.size = size
    if font:
        data.font = font
    obj = bpy.data.objects.new(text,data)
    SHEET_STUDIO.objects.link(obj)
    data.materials.append(text_mat)
    q = sheet_camera.rotation_euler.to_quaternion()
    obj.rotation_euler = sheet_camera.rotation_euler
    obj.location = q @ Vector((x,y,3.5))
    return obj


labels = ["FOUNDATION","CENTER PAD","TOWER BASE","TOWER","TOWER TOP","NACELLE TAIL","ROTOR HOUSING"]
for i,(key,title) in enumerate(zip(KEYS,labels)):
    x = (i-3)*1.46
    label(title,x,-.95,.101)
    label(key,x,-1.115,.070)
    label(f"{manifest['files'][key+'.glb']['triangle_count']:,} triangles",x,-1.255,.071)
label("CRAFTYAP / WIND TURBINE FRAMES",-5.03,1.64,.125,'LEFT')
label("1 m GRID  /  BASE = 2 CELLS  /  Y UP  /  +Z FRONT",5.03,1.64,.092,'RIGHT')

DOOR=bpy.data.scenes.new('Tower | robot-scale door closeup')
DOOR.collection.children.link(ASSEMBLED)
DOOR_STUDIO=new_collection('DOOR | studio',DOOR)
configure_scene(DOOR,DOOR_STUDIO,(1500,1700),target=(0,1.25,.1))
camera(DOOR,DOOR_STUDIO,(4.1,3.1,7.6),(-.12,1.35,.12),3.8)

# Save the complete editable source with the assembly as the opening scene.
bpy.context.window.scene = ASSEMBLY_SCENE
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.clip_end = 200
            area.spaces.active.overlay.show_overlays = False
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "Frames.blend"))

if '--no-render' not in sys.argv:
    for scene,filename in [(SHEET,"frames-sheet.png"),(ASSEMBLY_SCENE,"turbine-assembled.png"),(DOOR,"door-closeup.png")]:
        scene.render.filepath = str(PREVIEWS/filename)
        print("FRAME_RENDER " + filename,flush=True)
        bpy.ops.render.render(write_still=True,scene=scene.name)

print("FRAME_BUILD_COMPLETE " + json.dumps({k:v['triangle_count'] for k,v in manifest['files'].items()}),flush=True)
