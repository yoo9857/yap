# Bakes the fire drill's flame and smoke as FLIPBOOKS from a real gas simulation (Mantaflow).
#
#   blender -b -P assets/fx/fire/source/bake_fire.py -- <workdir> [frames] [resolution]
#
# A burner 0.7 m across burns in a 2.4 x 2.4 x 4.8 m box of air. Once the fire has settled, 64
# frames are rendered twice with Cycles, straight on, orthographic:
#   fire/####.png   the flames alone on black  (drawn additively: black adds nothing)
#   smoke/####.png  the smoke alone, lit from above, with alpha
# and tiled 8 x 8 into fire.png / smoke.png in <workdir>. `build.mjs` turns those into the WebP
# sheets the game loads (apps/client/public/textures/fx/). The picture's BOTTOM edge is the
# burner's surface: a flame drawn with it stands on what it burns.
import math
import os
import sys

import bpy
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
WORK = os.path.abspath(args[0])
FRAMES = int(args[1]) if len(args) > 1 else 64
RES = int(args[2]) if len(args) > 2 else 80
SETTLE = 40  # frames before the fire is a steady column
PASSES = args[3].split(",") if len(args) > 3 else ["fire"]
# What burns:
#   column  a burner 0.6 m across: one standing flame (a bin, a single thing on fire)
#   ridge   a strip of fuel 2.4 m long: a WALL of fire, low between its peaks like a mountain
#           ridge — what spilled fuel or a burning floor looks like. Drawn overlapping, these
#           join into one fire.
#   wall    a patch of a WALL burning (the wall stands at the back of the box): the fire runs up
#           the face and rolls out from it. Rendered twice from one simulation — straight on
#           (fire.png: what is drawn ON the face) and from the side (side.png: its profile, the
#           wall at the picture's RIGHT edge; drawn standing out of the face) — so a wall's fire
#           has depth from wherever it is seen.
SHAPE = args[4] if len(args) > 4 else "column"
WALL_Y = 0.3  # the burning face (wall shape)
if SHAPE == "wall":
    CELL_W, CELL_H = 128, 192
    VIEW_W, VIEW_H = 2.0, 3.0
    BOX = (2.4, 2.2, 3.6)
elif SHAPE == "ridge":
    CELL_W, CELL_H = 192, 128
    VIEW_W, VIEW_H = 3.0, 2.0  # metres the picture shows, from the fuel up
    BOX = (3.6, 1.8, 3.0)
else:
    CELL_W, CELL_H = 128, 192
    VIEW_W, VIEW_H = 2.0, 3.0
    BOX = (2.4, 2.4, 3.6)
COLS = 8
LOOP = 12  # extra frames rendered past the end and folded back over the start: the flipbook has no seam
os.makedirs(WORK, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, SETTLE + FRAMES + LOOP
scene.render.fps = 24

# ---- the air
W, D, H = BOX
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, WALL_Y + 0.2 - D / 2 if SHAPE == "wall" else 0, H / 2))
domain = bpy.context.object
domain.name = "Air"
domain.scale = (W, D, H)
bpy.ops.object.transform_apply(scale=True)
mod = domain.modifiers.new("Fluid", "FLUID")
mod.fluid_type = "DOMAIN"
d = mod.domain_settings
d.domain_type = "GAS"
d.resolution_max = RES
d.use_adaptive_domain = False
d.cache_type = "ALL"
d.cache_directory = os.path.join(WORK, "cache")
d.cache_frame_start, d.cache_frame_end = 1, SETTLE + FRAMES + LOOP
d.time_scale = 1.6
d.vorticity = 0.6
d.alpha = 1.0  # smoke's buoyancy from density
d.beta = 4.0  # …and from heat
d.burning_rate = {"ridge": 1.25, "wall": 0.8}.get(SHAPE, 0.6)  # slow to burn = tall flames
d.flame_smoke = 1.6
d.flame_vorticity = 1.0
d.flame_ignition = 1.5
d.flame_max_temp = 3.0
d.use_dissolve_smoke = True
d.dissolve_speed = 34
d.use_noise = True  # the fine curl a coarse grid cannot hold
d.noise_scale = 2
d.noise_strength = 1.0

# ---- the burner
if SHAPE == "wall":
    # the wall itself: the gas cannot pass it, so the fire has to run up it
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, WALL_Y + 0.1, H / 2))
    wall = bpy.context.object
    wall.name = "Wall"
    wall.scale = (W, 0.2, H)
    bpy.ops.object.transform_apply(scale=True)
    wmod = wall.modifiers.new("Fluid", "FLUID")
    wmod.fluid_type = "EFFECTOR"
    wmod.effector_settings.effector_type = "COLLISION"
    wall.hide_render = True
    # what burns on it: a patch 1.5 m wide from the floor to 1.3 m
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, WALL_Y - 0.04, 0.68))
    bpy.context.object.scale = (1.5, 0.05, 1.3)
    bpy.ops.object.transform_apply(scale=True)
elif SHAPE == "ridge":
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.05))
    bpy.context.object.scale = (2.4, 0.42, 0.06)
    bpy.ops.object.transform_apply(scale=True)
else:
    bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=0.06, location=(0, 0, 0.05))
burner = bpy.context.object
burner.name = "Burner"
fmod = burner.modifiers.new("Fluid", "FLUID")
fmod.fluid_type = "FLOW"
f = fmod.flow_settings
f.flow_type = "BOTH"
f.flow_behavior = "INFLOW"
f.fuel_amount = {"ridge": 0.85, "wall": 1.1}.get(SHAPE, 1.15)
f.temperature = 1.6
f.density = 0.6
f.surface_distance = 0.6
f.use_initial_velocity = True
f.velocity_normal = {"ridge": 0.25, "wall": 0.7}.get(SHAPE, 0.7)
if SHAPE in ("ridge", "wall"):
    # the fuel is patchy, and the patches wander: peaks where there is more of it, saddles between
    patches = bpy.data.textures.new("Patches", "CLOUDS")
    patches.noise_scale = 0.38
    patches.noise_depth = 1
    patches.contrast = 2.2
    f.use_texture = True
    f.noise_texture = patches
    f.texture_map_type = "AUTO"
    f.texture_size = 1.0
    f.texture_offset = 0.0
    f.keyframe_insert("texture_offset", frame=1)
    f.texture_offset = 1.6
    f.keyframe_insert("texture_offset", frame=SETTLE + FRAMES + LOOP)
burner.hide_render = True

# ---- bake
print("BAKE: start", flush=True)
bpy.context.view_layer.objects.active = domain
domain.select_set(True)
with bpy.context.temp_override(object=domain, active_object=domain, selected_objects=[domain]):
    bpy.ops.fluid.bake_all("EXEC_DEFAULT")
print("BAKE: done", flush=True)

# ---- look
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 40
scene.cycles.use_denoising = False
scene.cycles.volume_bounces = 1
scene.cycles.max_bounces = 3
scene.render.resolution_x, scene.render.resolution_y = CELL_W, CELL_H
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_depth = "8"
scene.view_settings.view_transform = "Standard"  # the game tone-maps for itself
scene.view_settings.look = "None"

cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = max(VIEW_W, VIEW_H)  # the long side; the picture's bottom edge = the fuel's surface
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam)
cam.location = (0, -10, VIEW_H / 2)
cam.rotation_euler = (math.radians(90), 0, 0)
scene.camera = cam
# the same fire in profile: looking along the wall, which stands at the picture's right edge
side_data = bpy.data.cameras.new("Side")
side_data.type = "ORTHO"
side_data.ortho_scale = max(VIEW_W, VIEW_H)
cam_side = bpy.data.objects.new("Side", side_data)
scene.collection.objects.link(cam_side)
SIDE_W = 1.0  # metres out from the wall the profile shows
cam_side.location = (10, WALL_Y - SIDE_W / 2, VIEW_H / 2)
cam_side.rotation_euler = (math.radians(90), 0, math.radians(90))

world = bpy.data.worlds.new("World")
world.use_nodes = True
scene.world = world
background = world.node_tree.nodes["Background"]

sun_data = bpy.data.lights.new("Sun", "SUN")
sun = bpy.data.objects.new("Sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(35), math.radians(20), 0)


def volume_material(name, fire):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    vol.inputs["Blackbody Intensity"].default_value = 0.0
    if fire:
        # the flame alone: how hot each bit of it is → colour and brightness; no smoke in the way
        vol.inputs["Density"].default_value = 0.0
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "flame"
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        r = ramp.color_ramp
        r.elements[0].position, r.elements[0].color = 0.0, (0, 0, 0, 1)
        r.elements[1].position, r.elements[1].color = 1.0, (1.0, 0.93, 0.7, 1)
        for pos, col in ((0.12, (0.55, 0.04, 0.0, 1)), (0.38, (1.0, 0.3, 0.02, 1)), (0.7, (1.0, 0.68, 0.16, 1))):
            e = r.elements.new(pos)
            e.color = col
        gain = nt.nodes.new("ShaderNodeMath")
        gain.operation = "MULTIPLY"
        gain.inputs[1].default_value = {"ridge": 7.5, "wall": 12.0}.get(SHAPE, 6.5)
        nt.links.new(attr.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(attr.outputs["Fac"], gain.inputs[0])
        nt.links.new(ramp.outputs["Color"], vol.inputs["Emission Color"])
        nt.links.new(gain.outputs["Value"], vol.inputs["Emission Strength"])
    else:
        vol.inputs["Color"].default_value = (0.42, 0.41, 0.4, 1)
        vol.inputs["Density"].default_value = 9.0
        vol.inputs["Anisotropy"].default_value = 0.2
        vol.inputs["Emission Strength"].default_value = 0.0
    return mat


def render_pass(name, fire, camera=None, cell_w=CELL_W):
    scene.camera = camera or cam
    scene.render.resolution_x = cell_w
    domain.data.materials.clear()
    domain.data.materials.append(volume_material(name, fire))
    scene.render.film_transparent = not fire
    scene.render.image_settings.color_mode = "RGB" if fire else "RGBA"
    background.inputs["Color"].default_value = (0, 0, 0, 1) if fire else (0.5, 0.52, 0.56, 1)
    background.inputs["Strength"].default_value = 0.0 if fire else 0.55
    sun_data.energy = 0.0 if fire else 5.0
    folder = os.path.join(WORK, name)
    os.makedirs(folder, exist_ok=True)
    for i in range(FRAMES + LOOP):
        scene.frame_set(SETTLE + 1 + i)
        scene.render.filepath = os.path.join(folder, f"{i:04d}.png")
        bpy.ops.render.render(write_still=True)
        if i % 8 == 0:
            print(f"RENDER {name}: {i + 1}/{FRAMES}", flush=True)
    # tile into one sheet, first frame top-left
    channels = 4
    rows = math.ceil(FRAMES / COLS)
    sheet = np.zeros((rows * CELL_H, COLS * cell_w, channels), dtype=np.float32)
    if fire:
        sheet[..., 3] = 1.0
    def frame(i):
        img = bpy.data.images.load(os.path.join(folder, f"{i:04d}.png"))
        data = np.array(img.pixels[:], dtype=np.float32).reshape(CELL_H, cell_w, img.channels)
        bpy.data.images.remove(img)
        return data

    for i in range(FRAMES):
        px = frame(i)
        if i < LOOP:  # what came after the last frame, fading into the first ones
            t = (i + 0.5) / LOOP
            px = frame(FRAMES + i) * (1 - t) + px * t
        row, col = divmod(i, COLS)
        y0 = (rows - 1 - row) * CELL_H  # image rows run bottom-up
        sheet[y0:y0 + CELL_H, col * cell_w:(col + 1) * cell_w, :px.shape[2]] = px
    result = bpy.data.images.new(name, COLS * cell_w, rows * CELL_H, alpha=True)
    result.pixels = sheet.ravel()
    result.filepath_raw = os.path.join(WORK, f"{name}.png")
    result.file_format = "PNG"
    result.save()
    print(f"SHEET {name}: {result.filepath_raw}", flush=True)


if "fire" in PASSES:
    render_pass("fire", True)
    if SHAPE == "wall":
        render_pass("side", True, cam_side, int(CELL_H * SIDE_W / VIEW_H))
if "smoke" in PASSES:
    render_pass("smoke", False)
print("ALL DONE", flush=True)
