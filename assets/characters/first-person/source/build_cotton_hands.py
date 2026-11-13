"""Fingerless cotton-candy cartoon hands: one soft pad and a tiny direction nub.

The whole pad gently squashes to hold a prop. No individual digits, creases,
knuckles, nails, bored fist, or anatomical finger articulation are modelled.
"""
import bpy,bmesh,math,json,struct,argparse,sys
from pathlib import Path
from mathutils import Vector

parser=argparse.ArgumentParser();parser.add_argument('--repo',default='C:/craftyap');parser.add_argument('--output')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
repo=Path(args.repo)
out=Path(args.output) if args.output else repo/'assets/characters/first-person'
out.mkdir(parents=True,exist_ok=True)
source=out/'source';source.mkdir(parents=True,exist_ok=True)
native=repo/'engine/assets/character-grip';native.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene;scene.unit_settings.system='METRIC';scene.render.fps=24
parts=[]

def oval(name,at,size):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=22,location=at)
    o=bpy.context.object;o.name=name;o.scale=size;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);parts.append(o)
    return o

# A single broad, rounded pad supplies the entire hand silhouette.
oval('One cotton-soft hand pad',(-.030,-.005,0),(.120,.085,.070))
oval('Tiny blended direction nub',(.062,.048,.028),(.030,.027,.028))
wv=[];wf=[];rings=24;sides=32
for i in range(rings):
    t=i/(rings-1);r=.075+.011*t*t
    for j in range(sides):wv.append((-.110-.45*t,-.002+r*math.cos(j*math.tau/sides),r*math.sin(j*math.tau/sides)))
for i in range(rings-1):
    for j in range(sides):
        a=i*sides+j;b=i*sides+(j+1)%sides;wf.append((a,a+sides,b+sides,b))
wf.extend([tuple(range(sides)),tuple(reversed(range((rings-1)*sides,rings*sides)))])
wm=bpy.data.meshes.new('Continuous plush wrist');wm.from_pydata(wv,[],wf);wm.update()
wo=bpy.data.objects.new('Continuous plush wrist',wm);scene.collection.objects.link(wo);parts.append(wo)
oval('Soft wrist transition',(-.110,-.002,0),(.050,.075,.075))
bpy.ops.object.select_all(action='DESELECT')
for o in parts:o.select_set(True)
bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();prototype=bpy.context.object
bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
remesh=prototype.modifiers.new('One continuous marshmallow surface','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.0025;remesh.use_smooth_shade=True
bpy.ops.object.modifier_apply(modifier=remesh.name)
smooth=prototype.modifiers.new('Smooth away all knuckle-like bumps','SMOOTH');smooth.factor=.8;smooth.iterations=12;bpy.ops.object.modifier_apply(modifier=smooth.name)
triangles=sum(len(p.vertices)-2 for p in prototype.data.polygons)
dec=prototype.modifiers.new('Game topology','DECIMATE');dec.ratio=min(1,5200/triangles);bpy.ops.object.modifier_apply(modifier=dec.name)
tri=prototype.modifiers.new('Stable soft-wrap triangles','TRIANGULATE');bpy.ops.object.modifier_apply(modifier=tri.name)
bm=bmesh.new();bm.from_mesh(prototype.data)
for _ in range(5):
    edges=[e for e in bm.edges if e.calc_length()>.014 and sum(v.co.x for v in e.verts)/2>-.100]
    if not edges:break
    bmesh.ops.subdivide_edges(bm,edges=edges,cuts=1,use_grid_fill=True)
bmesh.ops.triangulate(bm,faces=list(bm.faces));bm.to_mesh(prototype.data);bm.free()
for p in prototype.data.polygons:p.use_smooth=True
open_points=[v.co.copy() for v in prototype.data.vertices]
faces=[tuple(p.vertices) for p in prototype.data.polygons]

def smoothstep(a,b,x):
    t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)

def posed(p,amount,right):
    # The entire soft pad changes its silhouette as one piece. There are no digits.
    weight=smoothstep(-.110,-.010,p.x)
    a=.28*amount;c=math.cos(a);s=math.sin(a)
    dx=(p.x+.060)*(1-.16*amount);dy=(p.y+.005)*(1+.05*amount)
    target=Vector((-.060+dx*c-dy*s,-.005+dx*s+dy*c,p.z*(1+.025*amount)))
    result=p+(target-p)*weight
    if right:result.z+=.060
    else:
        blend=smoothstep(-.140,-.035,p.x)
        result.z=-result.z*(1-.10*blend)+.010*blend
    return result

mat=bpy.data.materials.new('Soft warm cartoon colour');mat.diffuse_color=(1,.638,.027,1);mat.use_nodes=True
mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=mat.diffuse_color
mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.80
bpy.data.objects.remove(prototype,do_unlink=True)
summaries=[];hand_objects=[]
for right in [False,True]:
    label='R' if right else 'L';winding=faces if right else [tuple(reversed(f)) for f in faces]
    index=[i for f in winding for i in f]
    mesh=bpy.data.meshes.new('Cotton hand '+label);mesh.from_pydata([posed(p,0,right) for p in open_points],[],winding);mesh.update()
    ob=bpy.data.objects.new('Cotton_Hand_'+label,mesh);scene.collection.objects.link(ob);ob.data.materials.append(mat)
    for f in mesh.polygons:f.use_smooth=True
    states={}
    for name,amount in [('open',0),('half',.5),('closed',1)]:
        for v,p in zip(mesh.vertices,open_points):v.co=posed(p,amount,right)
        mesh.update()
        states[name]={'positions':[round(float(c),6) for v in mesh.vertices for c in v.co],
                      'normals':[round(float(c),6) for v in mesh.vertices for c in v.normal]}
        suffix=('-right' if right else '')+('' if name=='closed' else '-'+name)
        with (native/('model'+suffix+'.bin')).open('wb') as f:
            for vi in index:f.write(struct.pack('<6f',*states[name]['positions'][vi*3:vi*3+3],*states[name]['normals'][vi*3:vi*3+3]))
    nub_vertex=min(range(len(open_points)),key=lambda i:(open_points[i]-Vector((.074,.071,.028))).length_squared)
    # Keep the runtime landmark key so left/right grip-direction checks still apply.
    data={**states['closed'],'indices':index,'poses':{'open':states['open'],'half':states['half']},'landmarks':{'thumbTipVertex':nub_vertex},'style':'fingerless cotton-candy cartoon pad'}
    filename='characterGripRight.json' if right else 'characterGrip.json'
    (repo/'apps/client/src/craft/fire'/filename).write_text(json.dumps(data,separators=(',',':')),encoding='utf-8')
    for i,v in enumerate(mesh.vertices):v.co=states['open']['positions'][i*3:i*3+3]
    ob.shape_key_add(name='Relaxed puff');half=ob.shape_key_add(name='Soft wrap');closed=ob.shape_key_add(name='Hold puff')
    for key,state in [(half,states['half']),(closed,states['closed'])]:
        for i,v in enumerate(key.data):v.co=state['positions'][i*3:i*3+3]
    for frame,h,c in [(1,0,0),(16,1,0),(32,0,1),(50,0,1),(66,1,0),(82,0,0)]:
        half.value=h;closed.value=c;half.keyframe_insert('value',frame=frame);closed.keyframe_insert('value',frame=frame)
    ob.location.z=-.18 if right else .18;ob['design']='Single smooth cotton-candy cartoon pad. No individual fingers or creases.'
    summaries.append({'side':label,'vertices':len(mesh.vertices),'triangles':len(index)//3});hand_objects.append(ob)
scene.frame_start=1;scene.frame_end=82;scene.frame_set(32)
for area in bpy.context.screen.areas if bpy.context.screen else []:
    if area.type=='VIEW_3D':
        area.spaces.active.shading.color_type='MATERIAL';region=area.spaces.active.region_3d
        region.view_location=(-.01,0,0);region.view_distance=.85
        region.view_rotation=(Vector((.24,.64,.50))-Vector((-.01,0,0))).to_track_quat('Z','Y')
bpy.ops.wm.save_as_mainfile(filepath=str(source/'FirstPersonHands.blend'))
bpy.ops.object.select_all(action='DESELECT')
for ob in hand_objects:ob.select_set(True)
bpy.context.view_layer.objects.active=hand_objects[0]
bpy.ops.export_scene.gltf(filepath=str(out/'first-person-hands.glb'),export_format='GLB',use_selection=True,export_yup=False,export_animations=True)
(out/'mesh-info.json').write_text(json.dumps({'version':'6.0.0','style':'Fingerless cotton-candy cartoon hands','units':'metres','hands':summaries,'wristDiameter':.150,'forearmLength':.45,'poses':['relaxed puff','soft wrap','hold puff'],'individualFingers':0,'creases':0,'thumb':'small nub on the inner side of the grasp','rightHandMirrored':False,'viewPose':'lower hands with FOV-aware framing'},indent=2),encoding='utf-8')
print(json.dumps(summaries))
