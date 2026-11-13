import bpy,json,struct,hashlib
from pathlib import Path
from mathutils import Vector
project=Path(__file__).resolve().parents[4]
asset=project/'assets/environments/fire-school'
public=project/'apps/client/public/models/environments/fire-school';public.mkdir(parents=True,exist_ok=True)
native=project/'engine/assets/fire-school';native.mkdir(parents=True,exist_ok=True)
s=bpy.data.scenes['CraftYap • Block School'];bpy.context.window.scene=s
assets=list(bpy.data.collections['SCHOOL | Editable modules'].objects)
for ob in s.objects:ob.select_set(False)
for ob in assets:
    ob.select_set(True)
    for m in ob.modifiers:
        if m.type=='BEVEL':m.show_viewport=False;m.show_render=False
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=str(public/'school.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_apply=True,export_yup=True,export_animations=False)
opaque=bytearray();glass=bytearray();dg=bpy.context.evaluated_depsgraph_get()
def srgb(v):return round(max(0,min(1,12.92*v if v<=.0031308 else 1.055*v**(1/2.4)-.055))*255)
for ob in assets:
    if ob.type!='MESH':continue
    ev=ob.evaluated_get(dg);mesh=ev.to_mesh();mesh.calc_loop_triangles();matrix=ev.matrix_world;normal_matrix=matrix.to_3x3().inverted().transposed()
    for tri in mesh.loop_triangles:
        mat=mesh.materials[tri.material_index] if mesh.materials else None
        c=tuple(mat.diffuse_color) if mat else (.8,.8,.8,1)
        if mat and mat.use_nodes:
            p=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
            if p:c=tuple(p.inputs['Base Color'].default_value)[:3]+(p.inputs['Alpha'].default_value,)
        target=glass if c[3]<.99 else opaque;rgba=[srgb(v) for v in c[:3]]+[round(c[3]*255)]
        for vi,li in zip(tri.vertices,tri.loops):
            p=matrix@mesh.vertices[vi].co;n=(normal_matrix@mesh.corner_normals[li].vector).normalized()
            target.extend(struct.pack('<6f4B',p.x,p.z+4,-p.y,n.x,n.z,-n.y,*rgba))
    ev.to_mesh_clear()
(native/'school-opaque.bin').write_bytes(opaque);(native/'school-glass.bin').write_bytes(glass)
info={'version':1,'stride':28,'opaqueVertices':len(opaque)//28,'glassVertices':len(glass)//28,'gameOffset':[0,4,0],'glbSha256':hashlib.sha256((public/'school.glb').read_bytes()).hexdigest()}
(native/'mesh.json').write_text(json.dumps(info,indent=2),encoding='utf-8')
print('FIRE_RUNTIME_EXPORTED',json.dumps(info),flush=True)
