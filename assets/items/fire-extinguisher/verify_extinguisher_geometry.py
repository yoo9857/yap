"""Check the saved Blender asset, including its actual hose end rings."""
import json, math, sys
from pathlib import Path
import bpy
from mathutils import Vector

scene = bpy.context.scene
scene.frame_set(1)
bpy.context.view_layer.update()

def get(name):
    obj = bpy.data.objects.get(name)
    assert obj is not None, name
    return obj

def world(name):
    return get(name).matrix_world.translation.copy()

def bounds(name):
    obj = get(name)
    xyz = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return [min(p.x for p in xyz), max(p.x for p in xyz)]

valve_chain = ['Valve', 'Valve discharge branch', 'Threaded union nut', 'Hose strain relief sleeve']
overlaps = []
for before, after in zip(valve_chain, valve_chain[1:]):
    overlap = min(bounds(before)[1], bounds(after)[1]) - max(bounds(before)[0], bounds(after)[0])
    assert overlap > .001, (before, after, overlap)
    overlaps.append(round(overlap * 1000, 2))
for name in valve_chain[1:]:
    assert abs(world(name).y) < 1e-6
    assert abs(world(name).z - world('Hose_Anchor').z) < 1e-6

hose = get('Flexible hose')
counts = [0] * len(hose.data.edges)
edge_use = {}
for poly in hose.data.polygons:
    for edge in poly.edge_keys:
        edge_use[edge] = edge_use.get(edge, 0) + 1
ends = {i for edge, count in edge_use.items() if count == 1 for i in edge}
assert ends, 'Hose geometry has no end-ring vertices'
vertices = [hose.matrix_world @ hose.data.vertices[i].co for i in ends]
results = []
for socket_name, axis in [('Hose_Anchor', Vector((1, 0, 0))), ('Nozzle_Hose_Socket', Vector((0, -1, 0)))]:
    socket = world(socket_name)
    ring = [v for v in vertices if (v-socket).length < .025]
    assert len(ring) >= 8, (socket_name, len(ring))
    centre = sum(ring, Vector()) / len(ring)
    axial_error = max(abs((v-centre).dot(axis)) for v in ring)
    distance = (centre-socket).length
    assert distance < .002 and axial_error < .001, (socket_name, distance, axial_error)
    results.append({'socket':socket_name, 'endVertices':len(ring), 'centreErrorMm':round(distance*1000,3), 'axialErrorMm':round(axial_error*1000,3)})

pin = world('Pin_Grip')
assert pin.x > bounds('Formed upper operating lever')[1] + .025
assert abs(pin.z-world('SafetyPin').z)<1e-6
print('MODEL_JOINTS',json.dumps({'valvePartOverlapMm':overlaps, 'hoseEnds':results}),flush=True)
