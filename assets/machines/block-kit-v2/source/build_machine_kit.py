"""Original CraftYap modular toy-machine kit, Blender source of truth.
Run in a fresh Blender background process. Does not edit an existing file.
Game coordinates: +Y up, +Z forward, wheels spin about +X; one grid cell=1m.
"""
import bpy,math,os,json,random,zlib,struct
from mathutils import Vector,Matrix

ROOT=os.environ.get('CRAFTYAP_VEHICLE_OUT') or os.path.abspath('outputs/CraftYap_vehicle_blocks_2026-11-03')
for folder in ['source','runtime','textures','previews']:os.makedirs(os.path.join(ROOT,folder),exist_ok=True)
def gp(p):return Vector((p[0],-p[2],p[1]))
def linear(v):return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def rgb(hex):return tuple(linear(int(hex[i:i+2],16)/255) for i in (0,2,4))
def png(name,mode):
    n=256;buf=bytearray();rng=random.Random(7123)
    for y in range(n):
        buf.append(0)
        for x in range(n):
            v=rng.randrange(-3,4)
            if mode=='albedo':pixel=(249+v,249+v,247+v,255)
            elif mode=='roughness':pixel=(min(255,238+v*2),)*3+(255,)
            else:pixel=(128+rng.randrange(-1,2),128+rng.randrange(-1,2),255,255)
            buf.extend(pixel)
    chunk=lambda k,d:struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
    data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',n,n,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(buf),9))+chunk(b'IEND',b'')
    path=os.path.join(ROOT,'textures',name);open(path,'wb').write(data);return path
maps={k:png('toy-'+k+'.png',k) for k in ['albedo','roughness','normal']}
images={k:bpy.data.images.load(p,check_existing=True) for k,p in maps.items()}
for k,img in images.items():
    if k!='albedo':img.colorspace_settings.name='Non-Color'
    img.pack()
def material(name,color,rough=.6,metal=0,alpha=1,emit=0,grain=True):
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');c=rgb(color)
    p.inputs['Base Color'].default_value=(*c,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal;p.inputs['Alpha'].default_value=alpha
    m.diffuse_color=(*c,alpha)
    if emit:p.inputs['Emission Color'].default_value=(*c,1);p.inputs['Emission Strength'].default_value=emit
    if alpha<1:m.surface_render_method='BLENDED';m.use_transparency_overlap=False
    if grain:
        # PBR map colours carry the paint factor so Blender's glTF exporter
        # can write standard base-color/normal/roughness textures directly.
        paint=bpy.data.images.new(name+' paint',256,256,alpha=True)
        rng=random.Random(81);pixels=[]
        for i in range(256*256):
            f=.985+rng.random()*.015;pixels.extend([c[0]*f,c[1]*f,c[2]*f,1])
        paint.pixels=pixels;paint.filepath_raw=os.path.join(ROOT,'textures',name.lower().replace(' ','-')+'-albedo.png');paint.file_format='PNG';paint.save();paint.pack()
        node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=paint;m.node_tree.links.new(node.outputs['Color'],p.inputs['Base Color'])
        node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=images['normal'];normal=m.node_tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.12;m.node_tree.links.new(node.outputs['Color'],normal.inputs['Color']);m.node_tree.links.new(normal.outputs['Normal'],p.inputs['Normal'])
    return m
M={
 'paint':material('Warm enamel','E4D6AC',.62,.03),
 'trim':material('Honey yellow','E7B85D',.54,.08),
 'dark':material('Soft graphite','435356',.7,.05),
 'metal':material('Brushed axle','A6B8B1',.34,.65),
 'rubber':material('Tire rubber','303C40',.93,0),
 'mint':material('Mint indicator','A8DDC8',.46,.02,emit=.16,grain=False),
 'glass':material('Sea glass','76B3AF',.2,.02,alpha=.47,grain=False),
 'red':material('Tail coral','DA7966',.5,.03,emit=.12,grain=False),
}
PARTS=['frame','cockpit','wheel','thruster','ballast','wing','balloon','gyro'];LIB={};REPORT=[]
def active(o):bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
def bevel(o,w,low):
    if w:
        mod=o.modifiers.new('Soft moulded edges','BEVEL');mod.width=w;mod.segments=1 if low else 2
        mod.affect='EDGES';mod.harden_normals=True
    n=o.modifiers.new('Weighted face normals','WEIGHTED_NORMAL');n.keep_sharp=True;n.weight=40
    return o
def register(o,kind,role,mat,parent):
    o.name=kind+'_'+role+'_'+mat;o.parent=parent;o['machineRole']=role;o.data.materials.append(M[mat]);return o
def box(kind,parent,dims,pos,mat='paint',round=.025,role='body',low=False):
    bpy.ops.mesh.primitive_cube_add(size=1,location=gp(pos));o=bpy.context.object;o.dimensions=(dims[0],dims[2],dims[1]);active(o);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);bevel(o,round,low);return register(o,kind,role,mat,parent)
def cylinder(kind,parent,r,h,pos,mat='trim',axis='y',role='body',low=False):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12 if low else 20,radius=r,depth=h,location=gp(pos));o=bpy.context.object
    if axis=='x':o.rotation_euler[1]=math.pi/2
    if axis=='z':o.rotation_euler[0]=math.pi/2
    bevel(o,min(.014,h*.15),low);return register(o,kind,role,mat,parent)
def ring(kind,parent,r,t,pos,mat='metal',axis='y',role='body',low=False):
    rot=(0,0,0) if axis=='y' else ((0,math.pi/2,0) if axis=='x' else (math.pi/2,0,0))
    bpy.ops.mesh.primitive_torus_add(major_segments=12 if low else 20,minor_segments=4 if low else 6,location=gp(pos),rotation=rot,major_radius=r,minor_radius=t);return register(bpy.context.object,kind,role,mat,parent)
def studs(k,p,low,positions=None,y=.515):
    for x,z in positions or [(-.245,-.245),(-.245,.245),(.245,-.245),(.245,.245)]:
        cylinder(k,p,.082,.025,(x,y-.017,z),'trim',role='studs',low=low)
        cylinder(k,p,.071,.045,(x,y+.012,z),'paint',role='studs',low=low)
def spring(k,p,low):
    for z in [-.145,.145]:
        cylinder(k,p,.04,.57,(-.24,-.325,z),'metal',role='wheel-strut',low=low)
        if low:continue
        curve=bpy.data.curves.new('Suspension spring','CURVE');curve.dimensions='3D';curve.bevel_depth=.012;curve.bevel_resolution=1
        spline=curve.splines.new('POLY');n=49;spline.points.add(n-1)
        for i in range(n):
            a=i/(n-1)*math.pi*8;point=gp((-.24+math.cos(a)*.058,-.53+i/(n-1)*.38,z+math.sin(a)*.058));spline.points[i].co=(*point,1)
        o=bpy.data.objects.new('Coil spring',curve);bpy.context.collection.objects.link(o);active(o);bpy.ops.object.convert(target='MESH');register(bpy.context.object,k,'wheel-strut','trim',p)
def make(k,low):
    p=bpy.data.objects.new(k+('_LOD1' if low else ''),None);bpy.context.collection.objects.link(p);p['machinePart']=k;p['kitVersion']='2.0.0'
    b=lambda dims,pos,mat='paint',r=.025,role='body':box(k,p,dims,pos,mat,r,role,low)
    c=lambda r,h,pos,mat='trim',axis='y',role='body':cylinder(k,p,r,h,pos,mat,axis,role,low)
    t=lambda r,th,pos,mat='metal',axis='y',role='body':ring(k,p,r,th,pos,mat,axis,role,low)
    if k=='frame':
        b((.96,.88,.96),(0,0,0),r=.045);b((.98,.07,.98),(0,.455,0),r=.022);b((.94,.08,.94),(0,-.45,0),'dark',.022)
        for sign in [-1,1]:
            b((.54,.18,.012),(0,-.04,sign*.484),'trim',.006);b((.35,.035,.010),(0,-.04,sign*.489),'dark',.004)
            b((.012,.18,.54),(sign*.484,-.04,0),'trim',.006);b((.010,.035,.35),(sign*.489,-.04,0),'dark',.004)
        studs(k,p,low)
    elif k=='cockpit':
        b((.96,.13,.96),(0,-.425,0),'dark',.035);b((.94,.16,.94),(0,-.305,0),r=.035)
        b((.55,.15,.5),(0,-.19,-.08),'dark',.045);b((.54,.44,.13),(0,.03,-.30),'dark',.045)
        for x in [-.415,.415]:
            for z in [-.38,.38]:b((.11,.67,.105),(x,.10,z),r=.025)
            b((.035,.45,.64),(x,.12,0),'glass',.01)
            b((.045,.045,.22),(x*1.13,-.13,0),'trim',.01)
        b((.73,.49,.035),(0,.12,.412),'glass',.012);b((.73,.43,.028),(0,.15,-.412),'glass',.01)
        b((.98,.11,.96),(0,.47,0),r=.04);b((.66,.11,.17),(0,-.09,.26),'dark',.025);b((.29,.018,.10),(0,-.025,.23),'mint',.007)
        for x in [-.29,.29]:b((.17,.075,.028),(x,-.22,.475),'mint',.012);b((.12,.06,.025),(x,-.22,-.475),'red',.01)
        t(.105,.018,(-.18,.015,.09),'dark','z')
        for x in [-.08,.04,.16]:b((.065,.016,.07),(x,-.012,.24),'mint' if x!=.04 else 'trim',.007)
        studs(k,p,low,positions=[(-.245,-.245),(.245,-.245)],y=.56)
    elif k=='wheel':
        c(.553,.37,(0,0,0),'rubber','x')
        for side in [-1,1]:
            t(.45,.06,(side*.184,0,0),'rubber','x');c(.348,.025,(side*.205,0,0),'paint','x');c(.235,.034,(side*.224,0,0),'dark','x');c(.124,.045,(side*.249,0,0),'trim','x');c(.055,.053,(side*.268,0,0),'metal','x')
            for i in range(5):
                a=i*math.tau/5;sp=b((.022,.065,.11),(side*.228,math.cos(a)*.268,math.sin(a)*.268),'metal',.013);sp.rotation_euler[0]=-a
        for i in range(12 if low else 20):
            a=i*math.tau/(12 if low else 20);tr=b((.32,.035,.105),(0,math.cos(a)*.562,math.sin(a)*.562),'rubber',.01);tr.rotation_euler[0]=-a
        # Independent non-spinning assemblies. Runtime scales only the spring
        # along suspension travel and flips the inward bracket on the left side.
        b((.50,.13,.35),(-.28,-.015,0),'dark',.025,'wheel-fixed');b((.12,.23,.34),(-.48,.015,0),'trim',.025,'wheel-fixed')
        spring(k,p,low)
        b((.32,.13,.37),(-.17,0,0),'dark',.025,'wheel-hub');c(.085,.32,(-.14,0,0),'metal','x','wheel-hub')
    elif k=='thruster':
        b((.88,.68,.88),(0,.05,0),'paint',.065);b((.94,.12,.94),(0,.43,0),'trim',.025)
        c(.34,.12,(0,-.34,0),'dark');c(.30,.11,(0,-.44,0),'metal');c(.245,.015,(0,-.495,0),'mint')
        for sign in [-1,1]:
            b((.50,.24,.025),(0,.05,sign*.447),'dark',.012);b((.025,.24,.50),(sign*.447,.05,0),'dark',.012)
            b((.30,.035,.03),(0,.06,sign*.467),'mint',.005)
        c(.035,.12,(0,.55,0),'mint')
        bpy.ops.mesh.primitive_cone_add(vertices=12,radius1=.085,radius2=0,depth=.13,location=gp((0,.66,0)));register(bpy.context.object,k,'body','mint',p)
        studs(k,p,low)
    elif k=='ballast':
        b((.96,.92,.96),(0,0,0),'paint',.055)
        for y in [-.36,.36]:b((.98,.10,.98),(0,y,0),'trim',.022)
        for sign in [-1,1]:
            b((.46,.18,.018),(0,0,sign*.486),'metal',.008)
            for y in [-.055,0,.055]:b((.28,.018,.010),(0,y,sign*.499),'dark',.004)
        studs(k,p,low)
    elif k=='wing':
        b((1.20,.11,.88),(0,0,0),'paint',.035);b((1.20,.09,.12),(0,.01,-.40),'trim',.02)
        for x in [-.49,.49]:b((.04,.14,.72),(x,0,.01),'dark',.012)
        for x in [-.26,0,.26]:b((.025,.012,.38),(x,.061,.09),'mint',.004)
        b((.26,.018,.055),(.40,.072,.20),'mint',.006);studs(k,p,low,y=.085)
    elif k=='gyro':
        b((.94,.10,.94),(0,-.43,0),'dark',.03);b((.94,.10,.94),(0,.43,0),'paint',.03)
        for x in [-.39,.39]:
            for z in [-.39,.39]:b((.12,.78,.12),(x,0,z),'trim',.025)
        for z in [-.42,.42]:b((.65,.53,.025),(0,0,z),'glass',.012)
        t(.28,.036,(0,0,0),'trim','z');t(.25,.034,(0,0,0),'metal','x');t(.21,.024,(0,0,0),'mint','y');c(.12,.18,(0,0,0),'mint','y');studs(k,p,low)
    elif k=='balloon':
        b((.74,.12,.74),(0,-.40,0),'trim',.035);b((.49,.13,.49),(0,-.30,0),'dark',.03)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12 if low else 20,ring_count=8 if low else 12,radius=1,location=gp((0,.11,0)));o=bpy.context.object;o.scale=(.46,.46,.43);register(o,k,'body','paint',p)
        for x in [-.26,.26]:c(.018,.30,(x,-.23,0),'metal')
        t(.435,.018,(0,.09,0),'trim','y')
        t(.443,.010,(0,.11,0),'trim','x');t(.443,.010,(0,.11,0),'trim','z')
    return p

# New process only: discard factory defaults, never an existing user's scene.
for o in list(bpy.data.objects):bpy.data.objects.remove(o,do_unlink=True)
for low in [False,True]:
    scene=bpy.context.scene if not low else bpy.data.scenes.new('Machine Library LOD1')
    scene.name='Machine Library LOD1' if low else 'Machine Library HQ';bpy.context.window.scene=scene
    parts={k:make(k,low) for k in PARTS};LIB[low]=parts
    bpy.context.view_layer.update();bpy.ops.object.select_all(action='DESELECT')
    for root in parts.values():
        root.select_set(True)
        for o in root.children_recursive:o.select_set(True)
    filepath=os.path.join(ROOT,'runtime','machine-kit-lod1-raw.glb' if low else 'machine-kit-raw.glb')
    bpy.ops.export_scene.gltf(filepath=filepath,export_format='GLB',use_selection=True,export_yup=True,export_extras=True,export_apply=True,export_normals=True,export_texcoords=True,export_materials='EXPORT',export_image_format='AUTO',export_cameras=False,export_lights=False)
    REPORT.append({'lod':1 if low else 0,'roots':len(parts),'objects':len(scene.objects),'file':filepath})

preview=bpy.data.scenes.new('Rover Showcase');bpy.context.window.scene=preview
PREVIEW_COLORS={'frame':'E4D6AC','cockpit':'A8DDC8','ballast':'78888A','wheel':'E4D6AC','thruster':'E7B85D','gyro':'8BBFD8','wing':'E4D6AC','balloon':'DA7966'}
preview_paints={}
for kind,color in PREVIEW_COLORS.items():
    m=M['paint'].copy();m.name='Preview '+kind;node=m.node_tree.nodes.get('Principled BSDF');source=node.inputs['Base Color'].links[0].from_socket;mul=m.node_tree.nodes.new('ShaderNodeMixRGB');mul.blend_type='MULTIPLY';mul.inputs[0].default_value=1
    target=rgb(color);base=rgb('E4D6AC');mul.inputs[2].default_value=(*(target[i]/base[i] for i in range(3)),1);m.node_tree.links.new(source,mul.inputs[1]);m.node_tree.links.new(mul.outputs[0],node.inputs['Base Color']);preview_paints[kind]=m
def clone(root,cell):
    anchor=bpy.data.objects.new('Preview '+root['machinePart'],None);preview.collection.objects.link(anchor);anchor.location=gp(cell)
    for src in root.children_recursive:
        o=src.copy();o.data=src.data;preview.collection.objects.link(o);o.parent=anchor;o.matrix_local=src.matrix_local.copy()
        for slot in o.material_slots:
            if slot.material==M['paint']:slot.link='OBJECT';slot.material=preview_paints[root['machinePart']]
        role=src.get('machineRole','body');kind=root['machinePart']
        if kind=='wheel':
            side=-1 if cell[0]<0 else 1
            if role in ['wheel-fixed','wheel-strut','wheel-hub'] and side<0:o.location.x=-o.location.x;o.rotation_euler[2]+=math.pi
            if role=='wheel-strut':o.scale.z*=.65/.65
            if role in ['body','wheel-hub']:o.location.z-=.65
        if role=='studs' and kind=='frame' and cell[0]==0 and cell[2] in [0,1]:o.hide_render=True
    return anchor
for z in range(-2,3):
    for x in [-1,0,1]:clone(LIB[False]['frame'],(x,0,z))
clone(LIB[False]['cockpit'],(0,1,1));clone(LIB[False]['gyro'],(0,1,0))
for x in [-2,2]:
    for z in [-2,2]:clone(LIB[False]['wheel'],(x,0,z))
for o in preview.objects:
    if o.parent is None:o.location.z+=1.23
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.01));floor=bpy.context.object;floor.name='Studio ground';floor.data.materials.append(material('Backdrop','CAD5BC',.95,grain=False))
world=bpy.data.worlds.new('Warm studio');world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(*rgb('E8EEE0'),1);world.node_tree.nodes['Background'].inputs[1].default_value=.8;preview.world=world
for name,loc,power,size in [('Key',(-5,-8,11),1800,8),('Fill',(7,-3,6),850,7),('Rim',(0,7,10),1400,6)]:
    bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;l.name=name;l.data.energy=power;l.data.shape='DISK';l.data.size=size;l.rotation_euler=(Vector((0,0,1.2))-l.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(9,-12,9));cam=bpy.context.object;cam.name='Rover Camera';cam.rotation_euler=(Vector((0,0,1.1))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=9;preview.camera=cam
preview.render.engine='BLENDER_EEVEE';preview.render.resolution_x=1400;preview.render.resolution_y=1000;preview.render.resolution_percentage=100;preview.render.image_settings.file_format='PNG';preview.render.film_transparent=False
preview.view_settings.view_transform='AgX';preview.render.filepath=os.path.join(ROOT,'previews','rover-blender.png')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source','CraftYap_MachineKit_v2.blend'))
open(os.path.join(ROOT,'blender-build.json'),'w',encoding='utf-8').write(json.dumps({'version':'2.0.0','blender':bpy.app.version_string,'provenance':'Original geometry and material maps created in Blender for CraftYap','parts':REPORT},indent=2))
bpy.ops.render.render(write_still=True)
print('CRAFTYAP_MACHINE_KIT_BUILT '+ROOT)
