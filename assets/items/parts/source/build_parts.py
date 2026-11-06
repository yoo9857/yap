"""Build CraftYap's three power-plant parts with Blender, without external assets.

Run: blender --background --factory-startup --python-exit-code 1 --python build_parts.py
All modelling dimensions below use the GAME convention: X right, Y up, Z front.
Mesh coordinates are baked into Blender's Z-up convention before glTF export.
The only non-identity asset transform is the specified rotor `spin` translation.
The studio scene uses linked display copies, scaled for comparison with the icons;
the Parts_Assets scene and exported GLBs retain their true dimensions in metres.
"""

import json
import math
import struct
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector


HERE = Path(__file__).resolve().parent.parent
SOURCE = HERE / "source"
RUNTIME = HERE / "runtime"
PREVIEWS = HERE / "previews"
for directory in (SOURCE, RUNTIME, PREVIEWS):
    directory.mkdir(parents=True, exist_ok=True)

TAU = 2.0 * math.pi
BUDGETS = {"part-generator": 6000, "part-blades": 3000,
           "part-wire-terminal": 3000}


def game_to_blender(p):
    return (p[0], -p[2], p[1])


def linear_channel(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name, hex_colour, metallic=0.0, roughness=0.4):
    rgb = tuple(linear_channel(int(hex_colour[i:i + 2], 16) / 255.0)
                for i in (0, 2, 4))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*rgb, 1.0)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = (*rgb, 1.0)
    mat["srgb_hex"] = "#" + hex_colour
    return mat


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def new_mesh(name, verts, faces, parent, mats, face_materials=None):
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata([game_to_blender(v) for v in verts], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    parent.users_collection[0].objects.link(obj)
    obj.parent = parent
    for mat in mats:
        mesh.materials.append(mat)
    for poly in mesh.polygons:
        poly.use_smooth = True
        if face_materials is not None:
            poly.material_index = face_materials[poly.index]
    if parent.name in ('part-generator','part-wire-terminal'):
        bm=bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
    return obj


def finish_bevel(obj, width=0.025, segments=2):
    activate(obj)
    bevel = obj.modifiers.new("Rounded edges", "BEVEL")
    bevel.width = width
    bevel.segments = segments
    bevel.limit_method = "ANGLE"
    bevel.harden_normals = True
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    normals = obj.modifiers.new("Weighted satin normals", "WEIGHTED_NORMAL")
    normals.keep_sharp = True
    normals.weight = 40
    bpy.ops.object.modifier_apply(modifier=normals.name)
    return obj


def box(name, centre, size, parent, mat, bevel=0.025, segments=2):
    x, y, z = (v * 0.5 for v in size)
    verts = [(centre[0] + dx, centre[1] + dy, centre[2] + dz)
             for dx, dy, dz in ((-x, -y, -z), (x, -y, -z),
                               (x, y, -z), (-x, y, -z),
                               (-x, -y, z), (x, -y, z),
                               (x, y, z), (-x, y, z))]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return finish_bevel(new_mesh(name, verts, faces, parent, [mat]),
                        min(bevel,min(size)*.45), segments)


def lathe(name, profile, parent, mats, segments=20, axis="Z",
          centre=(0, 0, 0), interval_materials=None, phase=0):
    """Closed low-poly surface of revolution, with rounded profile corners.

    Profile runs from the back/bottom to the front/top as (axial, radius).
    Endpoint discs use flat shading; the rounded shoulders use smooth normals.
    Axis mappings all preserve handedness.
    """
    verts, faces, face_mats, rings = [], [], [], []

    def position(a, u, v):
        if axis == "Z":
            p = (u, v, a)
        elif axis == "Y":
            p = (v, a, u)
        else:
            p = (a, u, v)
        return tuple(p[i] + centre[i] for i in range(3))

    for axial, radius in profile:
        ring = []
        for j in range(segments if radius > 0 else 1):
            theta = TAU * j / segments + phase
            ring.append(len(verts))
            verts.append(position(axial, radius * math.cos(theta),
                                  radius * math.sin(theta)))
        rings.append(ring)
    flat_faces = []
    if len(rings[0]) > 1:
        faces.append(tuple(reversed(rings[0])))
        face_mats.append(0)
        flat_faces.append(0)
    for i, (back, front) in enumerate(zip(rings, rings[1:])):
        mat_index = interval_materials[i] if interval_materials else 0
        for j in range(segments):
            jn = (j + 1) % segments
            if len(front) == 1:
                face = (back[j], back[jn], front[0])
            elif len(back) == 1:
                face = (back[0], front[jn], front[j])
            else:
                face = (back[j], back[jn], front[jn], front[j])
            faces.append(face)
            face_mats.append(mat_index)
    if len(rings[-1]) > 1:
        flat_faces.append(len(faces))
        faces.append(tuple(rings[-1]))
        face_mats.append(0)
    obj = new_mesh(name, verts, faces, parent, mats, face_mats)
    for index in flat_faces:
        obj.data.polygons[index].use_smooth = False
    return obj


def round_cylinder(name, a0, a1, radius, parent, mat, bevel=0.02,
                   segments=20, axis="Z", centre=(0, 0, 0)):
    b = min(bevel, (a1 - a0) * 0.49, radius * 0.8)
    k = 1.0 - math.sqrt(0.5)
    profile = [(a0, radius - b), (a0 + k * b, radius - k * b),
               (a0 + b, radius), (a1 - b, radius),
               (a1 - k * b, radius - k * b), (a1, radius - b)]
    return lathe(name, profile, parent, [mat], segments, axis, centre)


def make_root(key, scene):
    collection = bpy.data.collections.new(key)
    scene.collection.children.link(collection)
    root = bpy.data.objects.new(key, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.15
    root["units"] = "metres"
    root["front"] = "+Z (glTF)"
    collection.objects.link(root)
    return root


def lightning(name, side, root):
    # A slightly proud cast plate on each side of the forward steel barrel.
    outline = [(-0.008, 0.115), (0.057, 0.105), (0.019, 0.028),
               (0.077, 0.018), (-0.040, -0.115), (-0.012, -0.027),
               (-0.070, -0.018)]
    # outline coordinates are horizontal Z and vertical Y.
    verts = [(side * depth, 0.025 + y, 0.192 + z)
             for depth in (0.321, 0.348) for z, y in outline]
    n = len(outline)
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n)
              for i in range(n)]
    obj = new_mesh(name, verts, faces, root, [MAT["yellow"]])
    # Consistently orient concave extrusions on the two opposite side faces.
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    finish_bevel(obj, 0.009, 2)


def arc_tube(name, z, major, minor, a0, a1, root, mat,
             segments=20, sides=6, cy=-0.005):
    """Round wire/rib with capped ends; +X cutaway is a real opening."""
    verts, faces = [], []
    closed = abs(a1-a0-TAU) < 1e-6
    count = segments if closed else segments+1
    for i in range(count):
        a = a0 + (a1-a0)*i/segments
        for j in range(sides):
            b = TAU*j/sides
            r = major+minor*math.cos(b)
            verts.append((r*math.cos(a),cy+r*math.sin(a),z+minor*math.sin(b)))
    for i in range(segments):
        for j in range(sides):
            ni=(i+1)%count
            faces.append((i*sides+j,i*sides+(j+1)%sides,
                          ni*sides+(j+1)%sides,ni*sides+j))
    if not closed:
        faces += [tuple(reversed(range(sides))),
                  tuple((count-1)*sides+j for j in range(sides))]
    return new_mesh(name,verts,faces,root,[mat])


def sector(name, section, a0, a1, root, mat, segments=20, cy=-0.005):
    """Closed arc of an axial/radial cross-section (housing or magnet)."""
    verts, faces = [], []
    n=len(section)
    for i in range(segments+1):
        a=a0+(a1-a0)*i/segments
        verts += [(r*math.cos(a),cy+r*math.sin(a),z) for z,r in section]
    for i in range(segments):
        for j in range(n):
            faces.append((i*n+j,(i+1)*n+j,(i+1)*n+(j+1)%n,i*n+(j+1)%n))
    faces += [tuple(reversed(range(n))),tuple(segments*n+j for j in range(n))]
    return new_mesh(name,verts,faces,root,[mat])


def front_emblem(name, root, cx, cy, z, scale=1, triangle=True):
    """Small solid cast warning sign; geometry only, no textures."""
    def extrude(label, outline, depth, mat):
        verts=[(cx+x*scale,cy+y*scale,z+d) for d in (0,depth) for x,y in outline]
        n=len(outline)
        faces=[tuple(reversed(range(n))),tuple(range(n,2*n))]
        faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        return finish_bevel(new_mesh(name+label,verts,faces,root,[mat]),.004*scale,1)
    if triangle:
        extrude('_yellow_warning_triangle',[(-.125,-.10),(.125,-.10),(0,.125)],.009,MAT['yellow'])
    bolt=[(-.007,.066),(.042,.066),(.009,.010),(.039,.010),
          (-.033,-.071),(-.009,-.012),(-.040,-.012)]
    z += .010
    extrude('_lightning_bolt',bolt,.008,MAT['black'] if triangle else MAT['yellow'])


def build_generator(scene):
    root = make_root('part-generator',scene)
    root['cell_span_xyz']=[1,1,2]
    root['origin_note']='Centre of both occupied cells; local Z -1 to +1'
    root['base_underside_y']=-.45
    root['science']='A red/blue magnet rotor turns inside copper stator windings'
    box('generator_base_frame',(0,-.405,-.02),(.84,.09,1.94),root,MAT['green'],.028)
    for i,z in enumerate((-.61,.48),1):
        box(f'generator_mounting_feet_{i}',(0,-.302,z),(.69,.17,.18),root,MAT['green'],.025)
        for side in (-1,1):
            lathe(f'generator_foot_bolt_{i}_{side}',[(-.224,.029),(-.202,.029),(-.197,.023)],
                  root,[MAT['steel']],6,'Y',(side*.285,0,z))
    # The front-right quarter is removed, including the cooling fins.
    sector('stator_housing_true_side_cutaway',
           [(-.77,.305),(-.75,.34),(.54,.34),(.56,.305),(.54,.291),(-.75,.291)],
           math.radians(62),math.radians(298),root,MAT['steel'],24)
    for i,z in enumerate((-.62,-.40,-.18,.04,.26,.48),1):
        arc_tube(f'stator_cooling_rib_{i}',z,.351,.024,
                 math.radians(62),math.radians(298),root,MAT['dark_steel'],18,4)
    # Complete copper loops, with gaps along Z revealing the internal magnets.
    for i,z in enumerate((-.535,-.315,-.095,.125,.345),1):
        arc_tube(f'copper_coil_winding_{i}',z,.251,.027,0,TAU,root,MAT['copper'],22,6)
    round_cylinder('rotor_iron_core',-.65,.49,.119,root,MAT['dark_steel'],.018,20,
                   centre=(0,-.005,0))
    for i in range(4):
        a=math.radians(-86+i*90)
        sector(f'rotor_magnet_{i+1}_'+('RED' if i%2==0 else 'BLUE'),
               [(-.60,.123),(-.58,.166),(.43,.166),(.45,.123)],
               a,a+math.radians(82),root,MAT['red' if i%2==0 else 'blue'],8)
    for name,z0,z1 in [('rear',-.985,-.75),('front',.53,.64)]:
        round_cylinder('generator_'+name+'_bearing_endcap',z0,z1,.348,
                       root,MAT['dark_steel'],.023,24,centre=(0,-.005,0))
        round_cylinder('generator_'+name+'_bearing',z0-.008,z1+.008,.151,
                       root,MAT['steel'],.015,16,centre=(0,-.005,0))
    round_cylinder('generator_front_shaft',.625,.99,.065,root,MAT['steel'],.014,16,
                   centre=(0,-.005,0))
    round_cylinder('generator_coupling_disc',.81,.90,.178,root,MAT['brass'],.018,20,
                   centre=(0,-.005,0))
    for i in range(4):
        a=TAU*(i+.5)/4
        lathe(f'coupling_bolt_{i+1}',[(.899,.022),(.919,.022),(.924,.017)],
              root,[MAT['steel']],6,'Z',(.133*math.cos(a),-.005+.133*math.sin(a),0))
    box('generator_top_terminal_box',(0,.356,-.51),(.39,.24,.32),root,MAT['navy'],.033)
    front_emblem('generator_terminal_warning',root,0,.36,-.344,.68)
    for i,x in enumerate((-.115,.115),1):
        points=[bezier((x,.35,-.35),(x,.42,-.20),(x,.40,.04),(x*.8,.295,.20),t/12)
                for t in range(13)]
        tube(f'generator_thick_top_cable_{i}',points,.025,root,MAT['black' if i==1 else 'red'],8)
    return root


def interpolate(knots, t, col):
    for a, b in zip(knots, knots[1:]):
        if a[0] <= t <= b[0]:
            u = (t - a[0]) / (b[0] - a[0])
            return a[col] * (1 - u) + b[col] * u
    return knots[-1][col]


def build_blades(scene):
    root = make_root("part-blades", scene)
    spin = bpy.data.objects.new("spin", None)
    root.users_collection[0].objects.link(spin)
    spin.parent = root
    spin.location = game_to_blender((0, 0, -0.25))
    spin.empty_display_type = "SINGLE_ARROW"
    spin.empty_display_size = 0.28
    spin["rotation_axis_gltf"] = "+Z"
    spin["swept_diameter_metres"] = 5.18
    round_cylinder("rotor_hub", -0.08, 0.081, 0.211, spin,
                   MAT["hub"], 0.035, 24)
    lathe("rotor_blue_nose", [(0.075, 0.09), (0.082, 0.108),
                             (0.098, 0.113), (0.126, 0.107),
                             (0.153, 0.088), (0.175, 0.059),
                             (0.188, 0.027), (0.191, 0)],
          spin, [MAT["blue"]], 20)
    # Radius, full chord width, full airfoil thickness.  The near-tip rings form
    # a rounded end rather than a knife-point.  12-sided sections shade smoothly.
    knots = [(0.115, 0.247, 0.080), (0.22, 0.264, 0.082),
             (0.40, 0.285, 0.081), (0.62, 0.292, 0.077),
             (0.95, 0.272, 0.069), (1.35, 0.237, 0.060),
             (1.75, 0.196, 0.051), (2.12, 0.157, 0.044),
             (2.40, 0.124, 0.039), (2.50, 0.110, 0.036),
             (2.55, 0.090, 0.031), (2.577, 0.053, 0.022),
             (2.59, 0.0, 0.0)]
    radii = [0.115, 0.16, 0.22, 0.30, 0.40, 0.51, 0.62,
             0.78, 0.95, 1.15, 1.35, 1.55, 1.75, 1.94,
             2.12, 2.28, 2.40, 2.46, 2.50, 2.53, 2.55, 2.565, 2.577]
    sections = 12
    for blade in range(3):
        angle = blade * TAU / 3
        ca, sa = math.cos(angle), math.sin(angle)
        verts, faces = [], []
        for r in radii:
            width = interpolate(knots, r, 1)
            thickness = interpolate(knots, r, 2)
            pitch = math.radians(20 - 14 * (r / 2.59))
            sweep = 0.055 * (r / 2.59) ** 1.6
            cone = -0.033 * (r / 2.59) ** 1.4
            for j in range(sections):
                theta = TAU * j / sections
                chord = width * 0.5 * math.cos(theta)
                depth = thickness * 0.5 * math.sin(theta)
                x = sweep + chord * math.cos(pitch) + depth * math.sin(pitch)
                z = cone - chord * math.sin(pitch) + depth * math.cos(pitch)
                verts.append((x * ca - r * sa, x * sa + r * ca, z))
        faces.append(tuple(range(sections)))
        for ring in range(len(radii) - 1):
            for j in range(sections):
                a = ring * sections + j
                b = ring * sections + (j + 1) % sections
                faces.append((a, a + sections, b + sections, b))
        tip = len(verts)
        verts.append((0.055 * ca - 2.59 * sa,
                      0.055 * sa + 2.59 * ca, -0.033))
        last = (len(radii) - 1) * sections
        for j in range(sections):
            faces.append((last + j, tip, last + (j + 1) % sections))
        obj = new_mesh("rotor_blade_%d" % (blade + 1), verts, faces,
                       spin, [MAT["white"]])
        activate(obj)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode="OBJECT")
    return root


def bezier(a, b, c, d, t):
    return tuple((1-t)**3*a[i] + 3*(1-t)**2*t*b[i]
                 + 3*(1-t)*t*t*c[i] + t**3*d[i] for i in range(3))


def tube(name, points, radius, root, mat, sides=8):
    verts, faces = [], []
    last_normal = None
    for i, point in enumerate(points):
        p = Vector(point)
        tangent = (Vector(points[min(i + 1, len(points) - 1)])
                   - Vector(points[max(0, i - 1)])).normalized()
        if last_normal is None:
            normal = tangent.cross(Vector((0, 0, 1))).normalized()
        else:
            normal = (last_normal - tangent * last_normal.dot(tangent)).normalized()
        binormal = tangent.cross(normal).normalized()
        last_normal = normal
        # A final short taper rounds the exposed cable end.
        taper = 1.0
        if i == len(points) - 2:
            taper = 0.83
        elif i == len(points) - 1:
            taper = 0.42
        for j in range(sides):
            theta = TAU * j / sides
            v = p + radius * taper * (math.cos(theta) * normal
                                      + math.sin(theta) * binormal)
            verts.append(tuple(v))
    faces.append(tuple(reversed(range(sides))))
    for i in range(len(points) - 1):
        for j in range(sides):
            a = i * sides + j
            b = i * sides + (j + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.append(tuple((len(points) - 1) * sides + j for j in range(sides)))
    return new_mesh(name, verts, faces, root, [mat])


def build_terminal(scene):
    root=make_root('part-wire-terminal',scene)
    root['cell_span_xyz']=[1,1,1]
    root['enclosure_dimensions_xyz_metres']=[.70,.78,.55]
    root['overall_height_metres']=.95
    root['tower_side']='-X'
    box('cabinet_steel_plinth',(0,-.464,0),(.73,.072,.58),root,MAT['steel'],.022)
    box('cabinet_rounded_navy_body',(0,-.05,0),(.70,.78,.55),root,MAT['navy'],.04,3)
    box('cabinet_door_shadow_reveal',(0,-.055,.271),(.604,.669,.022),root,MAT['black'],.032)
    box('cabinet_front_access_door',(0,-.055,.29),(.576,.64,.032),root,MAT['navy'],.028)
    front_emblem('cabinet',root,-.055,.045,.309,.95)
    box('cabinet_pull_handle',(.205,-.025,.329),(.034,.177,.036),root,MAT['steel'],.013)
    for i in range(5):
        box(f'cabinet_front_vent_{i+1}',(-.047,-.211-i*.026,.309),(.278,.012,.008),
            root,MAT['dark_steel'],.004,1)
    for y in (-.27,.18):
        box(f'cabinet_hinge_{y}',(-.29,y,.306),(.026,.075,.024),root,MAT['steel'],.009,1)
    for name,x,colour in [('RED',-.17,'red'),('BLACK',.17,'black')]:
        lathe('terminal_hex_nut_'+name,[(.325,.075),(.336,.083),(.362,.083),(.372,.067)],
              root,[MAT['copper']],6,'Y',(x,0,-.025))
        lathe('terminal_insulated_post_'+name,[(.357,.047),(.398,.047)],
              root,[MAT['copper']],12,'Y',(x,0,-.025))
        lathe('terminal_cap_'+name,[(.388,.055),(.396,.069),(.435,.069),(.45,.054)],
              root,[MAT[colour]],12,'Y',(x,0,-.025))
    round_cylinder('tower_side_cable_gland',-.39,-.334,.064,root,MAT['steel'],.012,12,
                   'X',(0,-.29,.055))
    points=[bezier((-.369,-.29,.055),(-.48,-.29,.055),(-.466,-.32,.09),(-.469,-.465,.09),i/14)
            for i in range(15)]
    tube('thick_cable_toward_tower_minus_X',points,.028,root,MAT['black'],8)
    points=[bezier((.23,-.25,-.26),(.23,-.25,-.395),(.23,-.42,-.395),(.23,-.49,-.395),i/10)
            for i in range(11)]
    tube('steel_conduit_into_ground',points,.035,root,MAT['steel'],8)
    lathe('ground_conduit_flange',[(-.5,.064),(-.483,.064),(-.473,.045)],root,[MAT['dark_steel']],
          12,'Y',(.23,0,-.395))
    return root


def descendants(root):
    return [root] + [child for direct in root.children for child in descendants(direct)]


def triangulate_assets(roots):
    for root in roots:
        for obj in descendants(root):
            if obj.type != "MESH":
                continue
            if root.name != 'part-blades':
                bm=bmesh.new()
                bm.from_mesh(obj.data)
                assert all(e.is_manifold for e in bm.edges), obj.name
                assert all(f.calc_area()>1e-10 for f in bm.faces), obj.name
                assert bm.calc_volume(signed=True)>0, obj.name
                bm.free()
            activate(obj)
            modifier = obj.modifiers.new("Runtime triangles", "TRIANGULATE")
            modifier.keep_custom_normals = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            assert obj.location.length < 1e-8
            assert all(abs(v - 1) < 1e-8 for v in obj.scale)
            assert all(abs(v) < 1e-8 for v in obj.rotation_euler)


def read_glb(path):
    blob = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", blob)
    assert magic == 0x46546C67 and version == 2 and length == len(blob)
    offset, document, binary = 12, None, None
    while offset < len(blob):
        size, kind = struct.unpack_from("<II", blob, offset)
        data = blob[offset + 8: offset + 8 + size]
        if kind == 0x4E4F534A:
            document = json.loads(data)
        elif kind == 0x004E4942:
            binary = data
        offset += 8 + size
    return document, binary


def inspect_glb(path, key):
    """Validate actual exported bytes; report game-space, not Blender-space bounds."""
    doc, binary = read_glb(path)
    assert not doc.get("images") and not doc.get("textures"), "No textures allowed"
    nodes = doc["nodes"]
    scene_roots = doc["scenes"][doc.get("scene", 0)]["nodes"]
    assert len(scene_roots) == 1 and nodes[scene_roots[0]]["name"] == key
    root = nodes[scene_roots[0]]
    assert root.get("translation", [0, 0, 0]) == [0, 0, 0]
    assert root.get("rotation", [0, 0, 0, 1]) == [0, 0, 0, 1]
    assert root.get("scale", [1, 1, 1]) == [1, 1, 1]
    minimum, maximum = [float("inf")] * 3, [float("-inf")] * 3
    triangles, mesh_nodes = 0, 0
    all_points = []

    def transform(node):
        if "matrix" in node:
            return Matrix([node["matrix"][i:i + 4] for i in range(0, 16, 4)]).transposed()
        t = Matrix.Translation(Vector(node.get("translation", (0, 0, 0))))
        q = node.get("rotation", (0, 0, 0, 1))
        r = Quaternion((q[3], q[0], q[1], q[2])).to_matrix().to_4x4()
        s = Matrix.Diagonal((*node.get("scale", (1, 1, 1)), 1))
        return t @ r @ s

    def visit(index, parent_matrix):
        nonlocal triangles, mesh_nodes
        node = nodes[index]
        world = parent_matrix @ transform(node)
        if "mesh" in node:
            mesh_nodes += 1
            assert node.get("translation", [0, 0, 0]) == [0, 0, 0]
            assert node.get("scale", [1, 1, 1]) == [1, 1, 1]
            assert node.get("rotation", [0, 0, 0, 1]) == [0, 0, 0, 1]
            for primitive in doc["meshes"][node["mesh"]]["primitives"]:
                assert primitive.get("mode", 4) == 4
                assert "NORMAL" in primitive["attributes"]
                accessor = doc["accessors"][primitive["attributes"]["POSITION"]]
                assert accessor["componentType"] == 5126 and accessor["type"] == "VEC3"
                view = doc["bufferViews"][accessor["bufferView"]]
                start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
                stride = view.get("byteStride", 12)
                for i in range(accessor["count"]):
                    p = world @ Vector(struct.unpack_from("<3f", binary, start + stride * i))
                    all_points.append(tuple(p))
                    for axis in range(3):
                        minimum[axis] = min(minimum[axis], p[axis])
                        maximum[axis] = max(maximum[axis], p[axis])
                count = (doc["accessors"][primitive["indices"]]["count"]
                         if "indices" in primitive else accessor["count"])
                assert count % 3 == 0
                triangles += count // 3
        for child in node.get("children", []):
            visit(child, world)

    visit(scene_roots[0], Matrix.Identity(4))
    assert triangles <= BUDGETS[key], (key, triangles, BUDGETS[key])
    if key != "part-blades":
        limit = ([-.5,-.5,-1],[.5,.5,1]) if key=='part-generator' else ([-.5]*3,[.5]*3)
        assert all(minimum[i]>=limit[0][i]-1e-5 and maximum[i]<=limit[1][i]+1e-5 for i in range(3)), (key,minimum,maximum)
    if key == "part-generator":
        assert abs(minimum[1] + 0.45) < 1e-6
        assert maximum[2] > 0.48  # Front shaft faces +Z.
    if key == "part-wire-terminal":
        assert abs(minimum[1] + 0.5) < 1e-6
    if key == "part-blades":
        children = root.get("children", [])
        assert len(children) == 1 and nodes[children[0]]["name"] == "spin"
        spin = nodes[children[0]]
        assert all(abs(a-b) < 1e-6 for a, b in
                   zip(spin["translation"], (0, 0, -0.25)))
        assert len(spin["children"]) == 5
        radial = max(math.hypot(p[0], p[1]) for p in all_points)
        assert 2.58 < radial < 2.61
    for mat in doc.get("materials", []):
        pbr = mat["pbrMetallicRoughness"]
        assert "baseColorFactor" in pbr
        assert "baseColorTexture" not in pbr
    return {"triangle_count": triangles, "triangle_budget": BUDGETS[key],
            "bounding_box": {"min": [round(v, 7) for v in minimum],
                             "max": [round(v, 7) for v in maximum]},
            "node_names": [n["name"] for n in nodes],
            "root_node": key, "mesh_node_count": mesh_nodes,
            "file_bytes": path.stat().st_size,
            "cell_span_xyz": [1,1,2] if key=='part-generator' else [1,1,1],
            "origin": "centre of occupied volume"}


def export_assets(roots):
    manifest = {"schema_version": 1, "units": "metres", "up_axis": "+Y",
                "front_axis": "+Z", "bounding_box_space": "glTF root-local",
                "files": {}}
    for root in roots:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in descendants(root):
            obj.select_set(True)
        bpy.context.view_layer.objects.active = root
        path = RUNTIME / (root.name + ".glb")
        bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB",
                                  use_selection=True, export_yup=True,
                                  export_apply=True, export_normals=True,
                                  export_texcoords=False, export_materials="EXPORT",
                                  export_cameras=False, export_lights=False,
                                  export_animations=False, export_extras=False)
        entry = inspect_glb(path, root.name)
        if root.name == "part-blades":
            entry["spin"] = {"node": "spin", "translation": [0, 0, -0.25],
                             "rotation_axis": "+Z", "swept_diameter": 5.18}
        manifest["files"][path.name] = entry
    (RUNTIME / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def track_to(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat("-Z", "Y").to_euler()


def studio_scene(roots):
    scene = bpy.data.scenes.new("Studio_Preview")
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    bpy.context.window.scene = scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.resolution_x = 2100
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("Plain light studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.82, 0.85, 0.9, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
    scene.world = world
    camera_data = bpy.data.cameras.new("Sheet camera")
    camera = bpy.data.objects.new("Sheet camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (6.5, -11, 7.0)
    track_to(camera, (0, 0, 0))
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 10.8
    camera_data.lens = 55
    scene.camera = camera
    right = camera.rotation_euler.to_matrix() @ Vector((1, 0, 0))
    up = camera.rotation_euler.to_matrix() @ Vector((0, 1, 0))
    toward_camera = camera.location.normalized()
    # Separate illumination/background with a camera-ray world switch.  This
    # gives a nearly white sheet while retaining controlled satin highlights.
    world_nodes = world.node_tree.nodes
    rays = world_nodes.new("ShaderNodeLightPath")
    background_camera = world_nodes.new("ShaderNodeBackground")
    background_camera.inputs["Color"].default_value = (0.94, 0.95, 0.97, 1)
    background_camera.inputs["Strength"].default_value = 4.0
    mix = world_nodes.new("ShaderNodeMixShader")
    world.node_tree.links.new(rays.outputs["Is Camera Ray"], mix.inputs[0])
    world.node_tree.links.new(world_nodes["Background"].outputs[0], mix.inputs[1])
    world.node_tree.links.new(background_camera.outputs[0], mix.inputs[2])
    world.node_tree.links.new(mix.outputs[0], world_nodes["World Output"].inputs["Surface"])

    for root, offset in zip(roots, (-3.5, 0, 3.5)):
        meshes = [o for o in descendants(root) if o.type == "MESH"]
        # The same front-right view exposes the cutaway and cabinet door.
        orientation = Matrix.Identity(4)
        points = [orientation @ o.matrix_world @ v.co
                  for o in meshes for v in o.data.vertices]
        sx = [p.dot(right) for p in points]
        sy = [p.dot(up) for p in points]
        scale = min(2.83 / (max(sx) - min(sx)), 2.87 / (max(sy) - min(sy)))
        shift = (right * (offset - scale * (min(sx) + max(sx)) / 2)
                 + up * (0.15 - scale * (min(sy) + max(sy)) / 2))
        display = bpy.data.collections.new("Display / " + root.name)
        scene.collection.children.link(display)
        display["display_scale_only"] = scale
        for original in meshes:
            obj = bpy.data.objects.new("display_" + original.name, original.data)
            display.objects.link(obj)
            obj.matrix_world = (Matrix.Translation(shift) @ Matrix.Scale(scale, 4)
                                @ orientation @ original.matrix_world)

    label_mat = material("Sheet typography", "566577", 0, 1)
    captions = [("GENERATOR", "2 cells | copper coils + red/blue magnets"),
                ("ROTOR BLADES", "5.18 m swept diameter | Z-axis pivot"),
                ("WIRE TERMINAL", "0.95 m tall | tower cable on -X")]
    for offset, (title, subtitle) in zip((-3.5, 0, 3.5), captions):
        for text, size, height in ((title, 0.14, -1.67),
                                   (subtitle, 0.085, -1.91)):
            curve = bpy.data.curves.new("Caption", "FONT")
            curve.body = text
            curve.align_x = "CENTER"
            curve.align_y = "CENTER"
            curve.size = size
            obj = bpy.data.objects.new(text, curve)
            scene.collection.objects.link(obj)
            obj.location = right * offset + up * height + toward_camera * 0.1
            obj.rotation_euler = camera.rotation_euler
            curve.materials.append(label_mat)
    # This is a comparison sheet: display scale is explicitly called out.
    footer = bpy.data.curves.new("Display-scale note", "FONT")
    footer.body = "CRAFTYAP / POWER PLANT PARTS       |       DISPLAY SCALES NORMALIZED"
    footer.align_x = "CENTER"
    footer.align_y = "CENTER"
    footer.size = 0.072
    footer_obj = bpy.data.objects.new("Display-scale note", footer)
    scene.collection.objects.link(footer_obj)
    footer_obj.location = up * -2.33
    footer_obj.rotation_euler = camera.rotation_euler
    footer.materials.append(label_mat)

    def area(name, position, power, size, colour):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power
        data.shape = "DISK"
        data.size = size
        data.color = colour
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = position
        track_to(obj, (0, 0, 0))

    area("Large warm key", (-3, -5, 8), 1600, 7, (1.0, 0.93, 0.84))
    area("Broad cool fill", (6, -3, 3), 850, 6, (0.83, 0.91, 1.0))
    area("Soft rim", (-1, 5, 5), 1900, 5, (1.0, 0.97, 0.92))
    scene.render.filepath = str(PREVIEWS / "parts-sheet.png")
    scene["note"] = "Linked display meshes only; true metre-scale roots are in Parts_Assets."
    return scene


def generator_closeup(root):
    scene=bpy.data.scenes.new('Generator | cutaway closeup')
    for o in descendants(root):
        scene.collection.objects.link(o)
    bpy.context.window.scene=scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=64
    scene.cycles.use_denoising=True
    scene.render.resolution_x=1800
    scene.render.resolution_y=1400
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.view_settings.view_transform='AgX'
    scene.view_settings.look='AgX - Medium High Contrast'
    scene.world=bpy.data.worlds.new('Generator studio background')
    scene.world.use_nodes=True
    bg=scene.world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value=(.76,.80,.86,1)
    bg.inputs['Strength'].default_value=.5
    data=bpy.data.cameras.new('Generator cutaway camera')
    cam=bpy.data.objects.new(data.name,data)
    scene.collection.objects.link(cam)
    cam.location=game_to_blender((3.5,1.8,3.0))
    track_to(cam,game_to_blender((0,0,-.04)))
    data.type='ORTHO'
    data.ortho_scale=2.7
    scene.camera=cam
    for name,pos,power,size in [('Key',(1,4,3),350,4),('Fill',(-3,2,1),180,4),('Rim',(0,2,-4),300,3)]:
        ld=bpy.data.lights.new('Generator '+name,'AREA')
        ld.energy=power; ld.shape='DISK'; ld.size=size
        lo=bpy.data.objects.new(ld.name,ld)
        scene.collection.objects.link(lo)
        lo.location=game_to_blender(pos)
        track_to(lo,(0,0,0))
    scene.render.filepath=str(PREVIEWS/'generator-closeup.png')
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'Parts.blend'))
    bpy.ops.render.render(write_still=True,scene=scene.name)


def main():
    global MAT
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    asset_scene = bpy.context.scene
    asset_scene.name = "Parts_Assets"
    asset_scene.unit_settings.system = "METRIC"
    asset_scene.unit_settings.scale_length = 1.0
    MAT = {"steel": material("Steel grey #AEB8C2", "AEB8C2", 0.18, 0.40),
           "dark_steel": material("Dark steel #7F8994", "7F8994", 0.18, 0.43),
           "copper": material("Copper #D98A4A", "D98A4A", 0.60, 0.35),
           "brass": material("Brass collar", "CBA555", 0.60, 0.36),
           "green": material("Soft green #86AD94", "86AD94", 0.02, 0.46),
           "white": material("Blade white #F4F6F8", "F4F6F8", 0.03, 0.34),
           "hub": material("Hub grey #C9CFD6", "C9CFD6", 0.16, 0.38),
           "blue": material("Nose blue #6FA8E8", "6FA8E8", 0.08, 0.32),
           "navy": material("Navy box #4A6496", "4A6496", 0.02, 0.44),
           "red": material("Red cap #E0564F", "E0564F", 0.01, 0.40),
           "black": material("Black cap #3A3D44", "3A3D44", 0.01, 0.43),
           "yellow": material("Lightning yellow #FFCF3A", "FFCF3A", 0.02, 0.35)}
    roots = [build_generator(asset_scene), build_blades(asset_scene),
             build_terminal(asset_scene)]
    bpy.context.view_layer.update()
    triangulate_assets(roots)
    bpy.context.view_layer.update()
    manifest = export_assets(roots)
    studio = studio_scene(roots)
    # The saved file includes the finished comparison scene, while Parts_Assets
    # holds exact root origins and game-space geometry for further editing.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / "Parts.blend"))
    if '--no-render' not in sys.argv:
        bpy.ops.render.render(write_still=True, scene=studio.name)
        generator_closeup(roots[0])
    for file, entry in manifest["files"].items():
        print("VERIFIED %s: %d triangles; bounds %s" %
              (file, entry["triangle_count"], entry["bounding_box"]), flush=True)
    print("BUILD_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
