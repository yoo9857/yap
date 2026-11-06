"""Render a bag icon for every frame GLB: transparent background, 3/4 view from above, soft light.

blender --background --factory-startup --python-exit-code 1 --python render_icons.py -- <runtime dir> <out dir>
Writes <out dir>/<key>.png (512 px); tools convert them to 256 px WebP for /items/frames/.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
runtime, out = argv[0], argv[1]
os.makedirs(out, exist_ok=True)

KEYS = sorted(f[:-4] for f in os.listdir(runtime) if f.endswith(".glb"))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = True
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.92, 0.94, 0.97, 1)
    bg.inputs[1].default_value = 0.9
    scene.world = world
    return scene


def light(name, kind, energy, loc, rot):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    if kind == "AREA":
        data.size = 4
    obj = bpy.data.objects.new(name, data)
    obj.location = loc
    obj.rotation_euler = rot
    bpy.context.scene.collection.objects.link(obj)


for key in KEYS:
    scene = reset()
    bpy.ops.import_scene.gltf(filepath=os.path.join(runtime, key + ".glb"))
    meshes = [o for o in scene.objects if o.type == "MESH"]
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    center = (lo + hi) / 2
    size = max(hi - lo)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size * 1.55
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    # Blender Z is up (the glTF importer converts +Y up); view from front-right, above
    direction = Vector((1.0, -1.25, 0.95)).normalized()
    cam.location = center + direction * size * 4
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    light("key", "AREA", 260, center + Vector((2.5, -3, 4)) * max(size, 0.6), (math.radians(40), 0, math.radians(35)))
    light("fill", "AREA", 90, center + Vector((-3, -1, 2)) * max(size, 0.6), (math.radians(60), 0, math.radians(-60)))
    scene.render.filepath = os.path.join(out, key + ".png")
    bpy.ops.render.render(write_still=True)
    print("ICON", key)
