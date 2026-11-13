"""Editable CraftYap extinguisher, with moving parts and real metre anchors."""
import bpy,math,json,struct,hashlib
from pathlib import Path
from mathutils import Vector
out=Path(__file__).resolve().parent
repo=out.parents[2];public=repo/'apps/client/public/models/items/fire/extinguisher';public.mkdir(parents=True,exist_ok=True)
native=repo/'engine/assets/fire-extinguisher';native.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene;scene.name='CraftYap Extinguisher';scene.unit_settings.system='METRIC'
collection=bpy.data.collections.new('EXTINGUISHER | Game asset');scene.collection.children.link(collection)
def pos(p):return(p[0],-p[2],p[1])
def linear(v):return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def mat(name,color,rough=.36,metal=0):
 m=bpy.data.materials.new(name);m.diffuse_color=tuple(linear(int(color[k:k+2],16)/255)for k in(0,2,4))+(1,);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=m.diffuse_color;p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal;m.use_backface_culling=True;return m
mats={'red':mat('Signal red ABS','DA332C'),'dark':mat('Graphite hose','263842',.66),'white':mat('Cream label','FFF9EC',.6),'gold':mat('Safety yellow','F3AB22',.3),'metal':mat('Valve alloy','98A6AD',.32,.6),'green':mat('Gauge green','23A86A',.5),'navy':mat('CraftYap ink','213344',.6)}
def empty(name,p=(0,0,0),parent=None):
 ob=bpy.data.objects.new(name,None);collection.objects.link(ob);ob.location=pos(p);ob.parent=parent;return ob
root=empty('CraftYap_Extinguisher')
parts={n:empty(n,parent=root)for n in ['Body','SafetyPin','Lever','Hose','Nozzle']}
# glTF may store an animated node's translation only in its animation channel.
# Keep the installed location on an unanimated parent so a loader at rest sees the pin.
parts['SafetyPin'].parent=empty('SafetyPin_Mount',(.048,.635,.035),root)
parts['Lever'].location=pos((0,.62,-.055));parts['Nozzle'].location=pos((.14,.27,.22))
def own(ob,name,part,material,bevel=0):
 ob.name=name
 for c in list(ob.users_collection):c.objects.unlink(ob)
 collection.objects.link(ob);ob.parent=parts[part];ob.data.materials.append(mats[material])
 if bevel:
  mod=ob.modifiers.new('Moulded ABS edges','BEVEL');mod.width=bevel;mod.segments=2
 return ob
def box(name,p,s,material='dark',part='Body',bevel=.005):
 bpy.ops.mesh.primitive_cube_add(size=1,location=pos(p));ob=bpy.context.object;ob.scale=(s[0],s[2],s[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);return own(ob,name,part,material,bevel)
def cyl(name,p,r,h,material='red',part='Body',along_z=False):
 bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=r,depth=h,location=pos(p),rotation=(math.pi/2,0,0)if along_z else(0,0,0));ob=bpy.context.object
 for poly in ob.data.polygons:poly.use_smooth=len(poly.vertices)==4
 return own(ob,name,part,material,.003)
cyl('Tank', (0,.28,0),.12,.46)
cyl('Protective base',(0,.035,0),.125,.07,'dark')
bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,radius=1,location=pos((0,.50,0)));ob=bpy.context.object;ob.scale=(.12,.12,.065);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);own(ob,'Tank shoulder','Body','red')
cyl('Label band',(0,.29,0),.124,.14,'white')
cyl('Valve',(0,.575,0),.033,.095,'metal')
# Narrow stamped-metal handles, not broad solid blocks. Dimensions are in metres.
box('Fixed carry grip',(0,.598,.055),(.046,.010,.178),'dark',bevel=.004)
box('Handle rear support',(0,.603,-.043),(.041,.038,.017),'metal',bevel=.003)
# A thin formed upper lever: curved top sheet and folded side flanges.
profile=[(-.015,.015),(.025,.030),(.155,.036),(.19,.031)]
verts=[]
for x in [-.024,.024]:
 for z,y in profile:
  verts.extend([pos((x,y,z)),pos((x,y-.0038,z))])
faces=[]
for i in range(3):
 a=i*2;b=(i+1)*2;faces.extend([(a,b,b+8,a+8),(a+1,a+9,b+9,b+1),(a,a+1,b+1,b),(a+8,b+8,b+9,a+9)])
faces.extend([(0,8,9,1),(6,7,15,14)])
me=bpy.data.meshes.new('Formed upper lever');me.from_pydata(verts,[],faces);me.update()
import bmesh
bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(me);bm.free()
ob=bpy.data.objects.new('Formed upper operating lever',me);collection.objects.link(ob);own(ob,'Formed upper operating lever','Lever','dark',.0015)
for x in [-.022,.022]:box('Lever folded edge',(x,.021,.098),(.003,.014,.142),'dark','Lever',.001)
box('Moving pin lug',(0,.030,.09),(.012,.012,.018),'metal','Lever',.002)
cyl('Valve plunger',(0,.625,-.01),.012,.027,'metal')
def eyelet(name,p,part='Body'):
 bpy.ops.mesh.primitive_torus_add(major_segments=24,minor_segments=8,major_radius=.0095,minor_radius=.003,location=pos(p),rotation=(0,math.pi/2,0));own(bpy.context.object,name,part,'metal')
for x in [-.025,.025]:
 eyelet('Fixed pin eyelet',(x,.635,.035))
 box('Fixed pin support',(x,.618,.035),(.012,.014,.016),'metal',bevel=.002)
eyelet('Lever pin eyelet',(0,.015,.09),'Lever')
# The shaft runs horizontally through both fixed lugs and the moving lever lug.
box('Horizontal locking pin shaft',(-.048,0,0),(.118,.0055,.0055),'metal','SafetyPin',.001)
bpy.ops.mesh.primitive_torus_add(major_segments=28,minor_segments=8,major_radius=.024,minor_radius=.0045,location=pos((.025,0,0)),rotation=(math.pi/2,0,0));own(bpy.context.object,'Side pull ring','SafetyPin','gold')
# A separate short orange seal tag; it must not be mistaken for the pin shaft.
box('Tamper seal tag',(.004,-.014,-.008),(.008,.014,.003),'red','SafetyPin',.001)
cyl('Pressure gauge',(.036,.548,.12),.030,.021,'metal',along_z=True)
cyl('Gauge face',(.036,.548,.133),.025,.004,'white',along_z=True)
def sector(name,lo,hi,material):
 points=[(.036,.548,.136)]+[(.036+math.cos(t)*.021,.548+math.sin(t)*.021,.136) for t in [lo+(hi-lo)*i/16 for i in range(17)]]
 me=bpy.data.meshes.new(name);me.from_pydata([pos(p) for p in points],[],[(0,i,i+1) for i in range(1,len(points)-1)]);me.update();ob=bpy.data.objects.new(name,me);collection.objects.link(ob);own(ob,name,'Body',material)
sector('Gauge low pressure',math.radians(125),math.radians(225),'red')
sector('Gauge normal green zone',math.radians(55),math.radians(125),'green')
sector('Gauge high pressure',math.radians(-45),math.radians(55),'red')
for i in range(7):
 angle=math.radians(-45+i*45);box('Gauge scale tick',(.036+math.cos(angle)*.023,.548+math.sin(angle)*.023,.137),(.002,.002,.001),'navy',bevel=0)
box('Gauge needle normal',(.036,.556,.139),(.0028,.020,.002),'navy',bevel=0)
# Valve discharge port, union nut and strain relief all share a +X axis.
def x_cylinder(name,p,r,h,material,vertices=24):
 bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=r,depth=h,location=pos(p),rotation=(0,math.pi/2,0));return own(bpy.context.object,name,'Body',material,.0015)
x_cylinder('Valve discharge branch',(.049,.573,0),.016,.072,'metal')
x_cylinder('Threaded union nut',(.082,.573,0),.022,.022,'metal',6)
x_cylinder('Hose strain relief sleeve',(.107,.573,0),.016,.034,'dark')
for x in [.096,.104,.112,.120]:x_cylinder('Sleeve grip rib',(x,.573,0),.017,.003,'dark')
# The parked hose leaves the port tangentially, then makes one smooth hanging loop.
curve=bpy.data.curves.new('Hose curve','CURVE');curve.dimensions='3D';curve.bevel_depth=.012;curve.bevel_resolution=3;curve.resolution_u=12
sp=curve.splines.new('BEZIER');points=[(.124,.573,0),(.177,.557,0),(.207,.46,.015),(.193,.33,.10),(.14,.27,.16),(.14,.27,.195)];sp.bezier_points.add(len(points)-1)
for bp,p in zip(sp.bezier_points,points):bp.co=pos(p);bp.handle_left_type=bp.handle_right_type='AUTO'
for index,direction in [(0,(1,0,0)),(-1,(0,0,1))]:
 bp=sp.bezier_points[index];bp.handle_left_type=bp.handle_right_type='FREE';v=Vector(pos(direction))*.027;bp.handle_left=bp.co-v;bp.handle_right=bp.co+v
ob=bpy.data.objects.new('Flexible hose',curve);collection.objects.link(ob);ob.parent=parts['Hose'];curve.materials.append(mats['dark']);bpy.context.view_layer.objects.active=ob;ob.select_set(True);bpy.ops.object.convert(target='MESH');ob.select_set(False)
cyl('Nozzle hose coupling',(0,0,-.0125),.020,.025,'metal','Nozzle',True)
cyl('Nozzle grip',(0,0,.045),.021,.105,'dark','Nozzle',True)
# Hollow outlet: outer wall, inner wall and annular lip, with the dark recess set back.
verts=[]
for z,r in [(.083,.027),(.150,.027),(.150,.0105),(.096,.0105)]:
 for i in range(24):verts.append(pos((math.cos(i*math.tau/24)*r,math.sin(i*math.tau/24)*r,z)))
faces=[]
for ring in range(3):
 for i in range(24):j=(i+1)%24;faces.append((ring*24+i,ring*24+j,(ring+1)*24+j,(ring+1)*24+i))
me=bpy.data.meshes.new('Hollow nozzle');me.from_pydata(verts,[],faces);me.update();ob=bpy.data.objects.new('Hollow nozzle',me);collection.objects.link(ob);own(ob,'Hollow nozzle','Nozzle','dark')
cyl('Nozzle dark recess',(0,0,.097),.0105,.002,'navy','Nozzle',True)
grip=empty('Grip_Main',(0,.598,.055),root)
empty('Nozzle_Hose_Socket',(0,0,-.025),parts['Nozzle'])
tip=empty('Nozzle_Tip',(0,0,.153),parts['Nozzle'])
empty('Hose_Anchor',(.124,.573,0),root)
empty('Hose_Lead',(.184,.573,0),root)
empty('Pin_Grip',(.025,0,0),parts['SafetyPin'])
def label(text,p,size,material='navy'):
 cu=bpy.data.curves.new(text,'FONT');cu.body=text;cu.align_x=cu.align_y='CENTER';cu.size=size;cu.extrude=.0005
 ob=bpy.data.objects.new('Label '+text,cu);collection.objects.link(ob);ob.location=pos(p);ob.rotation_euler=(math.pi/2,0,0);ob.parent=parts['Body'];cu.materials.append(mats[material]);bpy.context.view_layer.objects.active=ob;ob.select_set(True);bpy.ops.object.convert(target='MESH');ob.select_set(False)
label('ABC',(0,.31,.1255),.057)
label('CRAFTYAP',(0,.255,.1255),.024)
for x in [-.035,0,.035]:box('Instruction pictogram',(x,.345,.126),(.022,.018,.002),'red',bevel=.001)
root.scale=(.8,.8,.8)
# Editable Blender clips; runtime gestures drive these same node transforms directly.
def clip(part,name,property,frames):
 ob=parts[part];original=getattr(ob,property).copy()
 for frame,value in frames:
  setattr(ob,property,value);ob.keyframe_insert(data_path=property,frame=frame)
 action=ob.animation_data.action;action.name=name
 ob.animation_data.action=None
 track=ob.animation_data.nla_tracks.new();track.name=name
 strip=track.strips.new(name,1,action);strip.extrapolation='NOTHING'
 if hasattr(strip,'action_slot') and action.slots:strip.action_slot=action.slots[0]
 setattr(ob,property,original)
pin=parts['SafetyPin'].location.copy();pulled=pin.copy();pulled.x+=.17
clip('SafetyPin','Pin_Pull','location',[(1,pin),(30,pulled)])
clip('Lever','Lever_Squeeze','rotation_euler',[(1,(0,0,0)),(20,(.20,0,0)),(35,(.20,0,0)),(45,(0,0,0))])
scene.frame_set(1)
bpy.context.view_layer.update()
assets=list(collection.objects)
for ob in scene.objects:ob.select_set(False)
for ob in assets:ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(public/'extinguisher.glb'),export_format='GLB',use_selection=True,export_apply=True,export_yup=True,export_animations=True,export_nla_strips=True,export_animation_mode="NLA_TRACKS")
bpy.ops.export_scene.fbx(filepath=str(out/'extinguisher.fbx'),use_selection=True,object_types={'MESH','EMPTY'},axis_forward='-Z',axis_up='Y',bake_anim=True,add_leaf_bones=False)
scene.frame_set(1)
raw=bytearray();descriptors=[];dg=bpy.context.evaluated_depsgraph_get()
def srgb(v):return round(max(0,min(1,12.92*v if v<=.0031308 else 1.055*v**(1/2.4)-.055))*255)
for name,parent in parts.items():
 start=len(raw)//28
 for ob in assets:
  if ob.type!='MESH':continue
  ancestor=ob.parent
  while ancestor is not None and ancestor!=parent:ancestor=ancestor.parent
  if ancestor is None:continue
  ev=ob.evaluated_get(dg);mesh=ev.to_mesh();mesh.calc_loop_triangles();matrix=ev.matrix_world;nm=matrix.to_3x3().inverted().transposed()
  for tri in mesh.loop_triangles:
   material=mesh.materials[tri.material_index];c=material.diffuse_color;rgba=[srgb(v)for v in c[:3]]+[255]
   for vi,li in zip(tri.vertices,tri.loops):
    p=matrix@mesh.vertices[vi].co;n=(nm@mesh.corner_normals[li].vector).normalized();raw.extend(struct.pack('<6f4B',p.x,p.z,-p.y,n.x,n.z,-n.y,*rgba))
  ev.to_mesh_clear()
 p=parent.matrix_world.translation;descriptors.append({'name':name,'start':start,'count':len(raw)//28-start,'pivot':[p.x,p.z,-p.y]})
info={'version':'1.3.1','units':'metres','height':.54,'grip':[0,.4784,.044],'nozzlePivot':[.112,.216,.176],'nozzleTip':[0,0,.1224],'hoseAnchor':[.0992,.4584,0],'hoseDirection':[1,0,0],'hoseRadius':.0096,'nozzleInlet':[0,0,-.02],'parts':descriptors,'modelSha256':hashlib.sha256((public/'extinguisher.glb').read_bytes()).hexdigest()}
(native/'model.bin').write_bytes(raw);(native/'parts.json').write_text(json.dumps(info,indent=2),encoding='utf-8')
(out/'extinguisher.json').write_text(json.dumps(info,indent=2),encoding='utf-8');(out/'extinguisher.glb').write_bytes((public/'extinguisher.glb').read_bytes())
# A clean product view, excluded from exports.
bpy.ops.object.camera_add(location=(1.05,-1.7,.95));cam=bpy.context.object;cam.rotation_euler=(Vector((.03,-.04,.33))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=1.1;scene.camera=cam
scene.world=bpy.data.worlds.new('Soft studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.63,.76,.78,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.8
for loc,power,size in [((1,-2,3),170,3),((-2,-1,1),80,2)]:
 d=bpy.data.lights.new('Softbox','AREA');d.energy=power;d.shape='DISK';d.size=size;ob=bpy.data.objects.new('Softbox',d);scene.collection.objects.link(ob);ob.location=loc;ob.rotation_euler=(Vector((0,0,.3))-ob.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES';scene.cycles.samples=24;scene.render.threads_mode='FIXED';scene.render.threads=4;scene.render.resolution_x=900;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.view_settings.view_transform='Khronos PBR Neutral';scene.render.image_settings.file_format='PNG';scene.render.filepath=str(out/'extinguisher-preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(out/'CraftYap_Extinguisher.blend'))
bpy.ops.render.render(write_still=True)
print('EXTINGUISHER_EXPORTED',json.dumps(info),flush=True)
