"""CraftYap Block School. Rebuild with Blender --background --python this_file.py."""
import bpy, math, json, os, random, sys
from mathutils import Vector
from pathlib import Path

SCRIPT_DIR=Path(__file__).resolve().parent
OUT = SCRIPT_DIR
OUT.mkdir(parents=True, exist_ok=True)
random.seed(17)
# Build into a new scene so this script is also safe to run in an existing file.
scene = bpy.data.scenes.new('CraftYap • Block School')
if bpy.context.window:
    bpy.context.window.scene = scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
root = bpy.data.collections.new('SCHOOL | Editable modules')
scene.collection.children.link(root)
studio = bpy.data.collections.new('PREVIEW | Cameras and lights')
scene.collection.children.link(studio)
collision_col = bpy.data.collections.new('COLLISION | Hidden game helpers')
scene.collection.children.link(collision_col)
collision_col.hide_render = True

palette = {
 'ivory':'F3F0DA','cream':'E4CCA2','teal':'109991','teal_light':'39C1AD',
 'navy':'213344','yellow':'F3AB22','orange':'EF8634','red':'EA5945',
 'white':'FFF9EC','glass':'6BC8E4','wood':'D4A25C','darkwood':'905B35',
 'chalk':'205A4E','grass':'74BA3C','grass_light':'A5D84B','leaf':'328A43',
 'leaf_light':'65B63E','trunk':'976135','paving':'E9DBB3','paving_alt':'CCB98D',
 'court':'E2954A','court_blue':'3BA3C1','metal':'536771','black':'263842',
 'purple':'A084D1','paper':'FAEED2','water':'45B9E2','blue':'297EC8',
 'blue_light':'48A6EA','red_light':'F47B52','soil':'B88048','soil_dark':'96653B'
}
palette.update({'tile_cream':'EEE9D5','tile_sand':'E8D6B8','tile_teal':'D8EBDD','tile_blue':'D8E8F0'})

def srgb(v):
    return v/12.92 if v<0.04045 else ((v+0.055)/1.055)**2.4
materials=[]; mid={}
for name,h in palette.items():
    c=[srgb(int(h[i:i+2],16)/255) for i in (0,2,4)]
    mat=bpy.data.materials.new('School / '+name)
    mat.diffuse_color=(*c,1)
    mat.use_nodes=True
    p=mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*c,1)
    p.inputs['Roughness'].default_value=.36 if name in ('teal','teal_light','yellow','ivory','red','blue','orange') else .68
    if name in ('teal','yellow','ivory','red','blue'):
        p.inputs['Coat Weight'].default_value=.18
        p.inputs['Coat Roughness'].default_value=.30
    if name=='glass':
        p.inputs['Alpha'].default_value=.26
        p.inputs['Roughness'].default_value=.23
        mat.diffuse_color=(*c,.26)
        if hasattr(mat,'surface_render_method'): mat.surface_render_method='DITHERED'
    else:
        mat.use_backface_culling=True
    mid[name]=len(materials); materials.append(mat)

# Fine moulded-plastic grain, exported as a small repeatable normal map.
grain=bpy.data.images.new('CraftYap ABS micrograin',width=128,height=128)
grain.colorspace_settings.name='Non-Color'
pixels=[];grain_rng=random.Random(83)
for _ in range(128*128):pixels.extend((.5+grain_rng.uniform(-.035,.035),.5+grain_rng.uniform(-.035,.035),1.,1.))
grain.pixels.foreach_set(pixels);grain.pack()
for name,idx in mid.items():
    if name in ('glass','water','chalk'):continue
    material=materials[idx];tree=material.node_tree;p=tree.nodes.get('Principled BSDF')
    tex=tree.nodes.new('ShaderNodeTexImage');tex.image=grain;tex.extension='REPEAT'
    normal=tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.16
    tree.links.new(tex.outputs['Color'],normal.inputs['Color']);tree.links.new(normal.outputs['Normal'],p.inputs['Normal'])

groups={}; boxes=[]; camera_boxes=[]; ramps=[]; portals=[]; room_info=[]
CUBE_VERTS=((-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1))
CUBE_FACES=((2,6,4,0),(5,7,3,1),(4,5,1,0),(3,7,6,2),(1,3,2,0),(6,7,5,4))
for _face in CUBE_FACES:
    _v=[Vector(CUBE_VERTS[i]) for i in _face]
    assert (_v[1]-_v[0]).cross(_v[2]-_v[0]).dot(sum(_v,Vector())/4)>0, 'Box face must point outwards'
def geom(group,verts,faces,mat):
    b=groups.setdefault(group, [[],[],[]])
    n=len(b[0]);b[0].extend(verts)
    b[1].extend(tuple(n+i for i in f) for f in faces)
    b[2].extend([mid[mat]]*len(faces))
def box(group,name,loc,size,mat='ivory',solid=False,rot=0):
    x,y,z=loc; sx,sy,sz=size
    co,si=math.cos(rot),math.sin(rot)
    verts=[(x+co*a*sx/2-si*b*sy/2,y+si*a*sx/2+co*b*sy/2,z+c*sz/2) for a,b,c in CUBE_VERTS]
    geom(group,verts,CUBE_FACES,mat)
    camera_boxes.append({'name':name,'group':group,'min':[min(v[k] for v in verts) for k in range(3)],'max':[max(v[k] for v in verts) for k in range(3)]})
    if solid:
        assert abs(rot)<1e-6, name
        boxes.append({'name':name,'min':[x-sx/2,y-sy/2,z-sz/2],'max':[x+sx/2,y+sy/2,z+sz/2]})
def cylinder(group,loc,radius,depth,mat='teal',sides=12):
    x,y,z=loc
    camera_boxes.append({'name':'Stud or round prop','group':group,'min':[x-radius,y-radius,z-depth/2],'max':[x+radius,y+radius,z+depth/2]})
    verts=[(x+radius*math.cos(i*2*math.pi/sides),y+radius*math.sin(i*2*math.pi/sides),z+h*depth/2) for h in (-1,1) for i in range(sides)]
    faces=[tuple(reversed(range(sides))),tuple(range(sides,2*sides))]
    faces += [(i,(i+1)%sides,(i+1)%sides+sides,i+sides) for i in range(sides)]
    geom(group,verts,faces,mat)
def text(body,loc,size=.45,mat='navy',rot=(math.pi/2,0,0),name=None):
    cu=bpy.data.curves.new(name or body,'FONT');cu.body=body;cu.align_x='CENTER';cu.align_y='CENTER';cu.size=size;cu.extrude=.003;cu.resolution_u=2
    ob=bpy.data.objects.new(name or 'Sign '+body,cu);root.objects.link(ob);ob.location=loc;ob.rotation_euler=rot;cu.materials.append(materials[mid[mat]])
    return ob
def beam(group,a,b,width,mat='white'):
    av,bv=Vector(a),Vector(b); d=bv-av
    axis=d.normalized(); ref=Vector((0,0,1))
    if abs(axis.dot(ref))>.98: ref=Vector((1,0,0))
    u=axis.cross(ref).normalized()*width/2;v=axis.cross(u).normalized()*width/2
    verts=[tuple(p+su*u+sv*v) for p in (av,bv) for su,sv in ((-1,-1),(-1,1),(1,-1),(1,1))]
    geom(group,verts,[(1,3,2,0),(6,7,5,4),(4,5,1,0),(3,7,6,2),(2,6,4,0),(5,7,3,1)],mat)
    camera_boxes.append({'name':'Rail beam','group':group,'min':[min(v[k] for v in verts) for k in range(3)],'max':[max(v[k] for v in verts) for k in range(3)]})
def rail(group,x0,x1,y0,y1,z):
    dist=math.hypot(x1-x0,y1-y0)
    count=max(1,math.ceil(dist/1.2))
    for i in range(count+1):
        t=i/count;x=x0+(x1-x0)*t;y=y0+(y1-y0)*t
        box(group,'Railing post',(x,y,z+.54),(.09,.09,1.08),'teal')
    beam(group,(x0,y0,z+1.08),(x1,y1,z+1.08),.12,'teal')
    beam(group,(x0,y0,z+.45),(x1,y1,z+.45),.07,'teal_light')
def opening_wall(group,axis,const,start,end,z,height,openings,mat='ivory',thick=.28):
    # openings: [horizontal low, high, vertical low, high], absolute positions.
    us=sorted(set([start,end]+[a for op in openings for a in op[:2] if start<a<end]))
    zs=sorted(set([z,z+height]+[a for op in openings for a in op[2:] if z<a<z+height]))
    for a,b in zip(us,us[1:]):
        for c,d in zip(zs,zs[1:]):
            u,v=(a+b)/2,(c+d)/2
            if any(l<u<r and lo<v<hi for l,r,lo,hi in openings): continue
            loc=(u,const,v) if axis=='X' else (const,u,v)
            dims=(b-a,thick,d-c) if axis=='X' else (thick,b-a,d-c)
            box(group,'Wall',loc,dims,mat,True)
def window(x,y,z,width=4.8,height=1.9,side=False):
    g='Exterior | Frames and glazing'
    if not side:
        box(g,'Glazing',(x,y,z),(width,.055,height),'glass',True)
        for xx in (-width/2,0,width/2):box(g,'Mullion',(x+xx,y-.04,z),(.10,.14,height+.14),'teal')
        for zz in (-height/2,height/2):box(g,'Window frame',(x,y-.04,z+zz),(width+.18,.17,.12),'teal')
        box(g,'Window sill',(x,y-.14,z-height/2-.12),(width+.45,.48,.16),'white')
    else:
        box(g,'Glazing',(x,y,z),(.055,width,height),'glass',True)
        for yy in (-width/2,0,width/2):box(g,'Mullion',(x,y+yy,z),(.14,.10,height+.14),'teal')
        for zz in (-height/2,height/2):box(g,'Window frame',(x,y,z+zz),(.17,width+.18,.12),'teal')
def doorway(group,cx,y,z,label,accent='teal'):
    # Permanently open portal, no door leaf or invisible pane in the passage.
    for x in (cx-1.05,cx+1.05):box(group,'Door jamb',(x,y,z+1.5),(.12,.36,3),'teal')
    box(group,'Door header',(cx,y,z+3.04),(2.22,.38,.16),'teal')
    box(group,'Room plaque',(cx,y-.23,z+3.47),(2.5,.10,.46),accent)
    text(label,(cx,y-.295,z+3.47),.24,'white')
    portals.append({'label':label,'center':[cx,y,z],'clearWidth':1.98,'clearHeight':2.96})

# The campus is on z=0; north is +Y. 1 Blender unit = 1 metre.
box('Campus | Ground','Ground',(0,0,-.55),(78,70,1.04),'grass',True)
box('Campus | Ground','Foundation',(0,12,-.17),(49,21,.30),'cream',True)
# Layered earth and grass make the campus belong to the block village.
box('Campus | Terrain edge','Soil core',(0,0,-1.05),(78,70,1.25),'soil')
for side in (-1,1):
    for i in range(-18,19):
        box('Campus | Terrain edge','Soil edge',(i*2,side*34.92,-.55),(1.96,.18,.72),'soil' if i%3 else 'soil_dark')
        box('Campus | Terrain edge','Grass lip',(i*2,side*34.94,-.14),(1.98,.22,.20),'grass_light' if i%4==0 else 'grass')
    for i in range(-16,17):
        box('Campus | Terrain edge','Soil edge',(side*38.92,i*2,-.55),(.18,1.96,.72),'soil' if i%3 else 'soil_dark')
        box('Campus | Terrain edge','Grass lip',(side*38.94,i*2,-.14),(.22,1.98,.20),'grass')
box('Campus | Paving','Front plaza',(0,-3,.025),(53,10,.05),'paving',True)
box('Campus | Paving','Main promenade',(0,-21,.035),(6,27,.07),'paving',True)
box('Campus | Paving','Assembly pad',(0,-17,.125),(6,6,.05),'paving',True)
box('Campus | Paving','Rear path',(0,25,.025),(53,5,.05),'paving',True)
for x in (-27,27):box('Campus | Paving','Side path',(x,12.25,.025),(4,20.5,.05),'paving',True)
for y in range(-33,2,2):
    for x in (-2,0,2):
        box('Campus | Paving','Paving joint',(x,y,.076),(1.96,.035,.018),'paving_alt')
for x in range(-26,27,2):box('Campus | Paving','Plaza seam',(x,-3,.061),(.025,9.8,.018),'paving_alt')
for yy in range(-32,-7,2):
    for xx in (-2,0,2):
        box('Campus | Paving','Village stepping slab',(xx+(.08 if yy%4 else -.08),yy,.085),(1.8,1.75,.08),'paper' if (xx+yy)%4 else 'cream',True)

# Two connected floors, with a true opening around the switchback stair.
box('Level 0 | Structure','Floor',(0,12,-.12),(48,20,.24),'paper',True)
for x in (-14.1,14.1):box('Level 1 | Structure','Floor wing',(x,12,4.26),(19.8,20,.28),'paper',True)
box('Level 1 | Structure','Front landing',(0,6.2,4.26),(8.4,8.4,.28),'paper',True)
box('Level 1 | Structure','Rear landing',(0,20,4.26),(8.4,4,.28),'paper',True)
box('Level 1 | Structure','Atrium side passage',(3.05,14.2,4.26),(2.3,7.6,.28),'paper',True)
for level in range(2):
    z=4.4*level; g=f'Level {level} | Structure'
    opfront=[[-4.05,4.05,z,z+3.3]] if level==0 else [[-3.1,3.1,z+1.05,z+3.15]]
    for x in (-19,-9.5,9.5,19):opfront.append([x-2.5,x+2.5,z+1.15,z+3.15])
    opening_wall(g,'X',2,-24,24,z,4.4,opfront)
    rear=[[x-2.5,x+2.5,z+1.15,z+3.15] for x in (-19,-9.5,9.5,19)]
    if level==0:rear.append([-1.3,1.3,0,3.1])
    else:rear.append([-2,2,z+1.15,z+3.15])
    opening_wall(g,'X',22,-24,24,z,4.4,rear)
    for x in (-24,24):
        ops=[[a-1.5,a+1.5,z+1.15,z+3.15] for a in (10,17)]
        opening_wall(g,'Y',x,2,22,z,4.4,ops)
        for y in (10,17):window(x,y,z+2.15,3,2,True)
    for x in (-19,-9.5,9.5,19):
        window(x,1.95,z+2.15,5,2);window(x,22.02,z+2.15,5,2)
    if level:window(0,1.95,z+2.1,6.2,2.1);window(0,22.02,z+2.15,4,2)
    # Clear 4.5 m circulation hall in front of the teaching rooms.
    for a,b,cx in [(-24,-14.25,-16),(-14.25,-4.2,-6.1),(4.2,14.25,6.1),(14.25,24,16)]:
        opening_wall(g,'X',6.7,a,b,z,4.4,[[cx-1,cx+1,z,z+3]])
    for x in (-14.25,14.25):box(g,'Room division',(x,14.35,z+2.2),(.22,15.3,4.4),'ivory',True)
    for x in (-4.2,4.2):box(g,'Central hall division',(x,14.35,z+2.2),(.25,15.3,4.4),'ivory',True)
    for x in (-14,14):box(f'Level {level} | Corridor','Wayfinding runner',(x,4.4,z-.006),(18,1.1,.012),'teal_light')
    for xx in range(-23,24,2):
        for yy in (2.8,6):
            box(f'Level {level} | Corridor','Floor tile',(xx,yy,z-.006),(1.96,1.3,.012),'paper' if xx%4 else 'white')
    for x in (-22,-12,12,22):
        box(f'Level {level} | Corridor','Ceiling light',(x,4.5,z+4.07),(2,.55,.06),'white')
    for x in (-22.9,22.9):
        for yy in (3.1,4.1,5.1):
            box(f'Level {level} | Corridor','Locker',(x,yy,z+1.05),(.65,.86,2.1),'teal')
            box(f'Level {level} | Corridor','Locker inset',(x+(.335 if x<0 else -.335),yy,z+1.09),(.025,.68,1.84),'teal_light')
    # Block facade trims and regular masonry seams.
    for yy in (1.79,22.2):
        gap=4.1 if yy<2 else 1.35
        if level==0:
            for sign in (-1,1):box('Exterior | Blockwork','Floor band',(sign*(24.2+gap)/2,yy,z+.22),(24.2-gap,.25,.42),'cream')
        else:box('Exterior | Blockwork','Floor band',(0,yy,z+.22),(48.4,.25,.42),'cream')
        box('Exterior | Blockwork','Teal lintel',(0,yy,z+4.13),(48.5,.32,.22),'teal')
        for xx in range(-23,24,2):
            if level==0 and abs(xx)<gap:continue
            box('Exterior | Blockwork','Base block joint',(xx,yy-.015,z+.25),(.024,.29,.42),'ivory')
    for xx in (-23.65,-4.5,4.5,23.65):
        for k in range(5):box('Exterior | Blockwork','Corner block',(xx,1.72,z+.45+k*.8),(.75,.35,.74),'cream')
    for xx,accent in [(-19,'yellow'),(-9.5,'teal'),(9.5,'blue'),(19,'red')]:
        box('Exterior | Colour blocks','Colour sill',(xx,1.63,z+.82),(5.35,.55,.42),accent)
        for sx in (-1,1):
            for kk in range(3):box('Exterior | Colour blocks','Window corner',(xx+sx*2.7,1.67,z+1.45+kk*.66),(.32,.48,.60),accent)
        for dx in (-2,-1,0,1,2):cylinder('Exterior | Colour blocks',(xx+dx,1.60,z+1.1),.17,.16,accent,8)
        box('Exterior | Colour blocks','Window crown',(xx,1.65,z+3.31),(5.8,.50,.22),accent)

# Roof: stepped block parapets. Decorative studs are safely above play space.
box('Roof | Main','Roof deck',(0,12,8.91),(49.4,21.4,.30),'teal',True)
for yy in (1.35,22.65):box('Roof | Main','Parapet',(0,yy,9.25),(49.4,.35,.55),'teal')
for xx in (-24.5,24.5):box('Roof | Main','Parapet',(xx,12,9.25),(.35,21.4,.55),'teal')
for xx in range(-23,24,2):
    for yy in (1.35,22.65):
        box('Roof | Block studs','Roof block',(xx,yy,9.56),(1.9,.9,.22),'teal_light')
        for dx in (-.45,.45):cylinder('Roof | Block studs',(xx+dx,yy,9.73),.22,.15,'teal_light',8)
box('Roof | Tower','Central tower',(0,6.2,10.8),(9,6.8,4),'ivory',True)
box('Roof | Tower','Tower cap',(0,6.2,12.93),(9.7,7.5,.28),'yellow')
for x in range(-4,5,2):
    for y in (3.2,9.2):cylinder('Roof | Tower',(x,y,13.18),.40,.24,'yellow',12)
# Square clock, recognizable in the block vocabulary.
box('Roof | Tower','Clock surround',(0,2.57,11.45),(2.85,.42,2.85),'teal')
box('Roof | Tower','Clock face',(0,2.32,11.45),(2.35,.12,2.35),'white')
box('Roof | Tower','Clock minute',(0,2.235,11.80),(.11,.045,.82),'navy')
box('Roof | Tower','Clock hour',(.32,2.23,11.45),(.75,.045,.11),'navy')
for dx,dz in [(0,.92),(.92,0),(0,-.92),(-.92,0)]:box('Roof | Tower','Clock marker',(dx,2.23,11.45+dz),(.14,.045,.14),'yellow')
for xx in (-4.05,4.05):
    for k in range(5):box('Roof | Tower','Tower corner',(xx,2.67,9.25+k*.7),(.72,.44,.64),'yellow')
# The village roof silhouette is built from visible, chunky layers.
for cx,base,light in [(-14.4,'red','red_light'),(14.4,'blue','blue_light')]:
    for tier in range(8):
        sy=22.8-tier*2.65
        box('Roof | Village gables','Stepped roof',(cx,12,9.34+tier*.38),(20.65,sy,.40),base)
        yy=12-sy/2-.015
        for k in range(13):
            xx=cx-9.6+k*1.6
            box('Roof | Village gables','Shingle block',(xx,yy+.45,9.58+tier*.38),(1.51,.94,.13),light if k%4==0 else base)
            cylinder('Roof | Village studs',(xx,yy+.45,9.70+tier*.38),.20,.12,light if k%4==0 else base,8)
    for yy in (4.4,):
        box('Roof | Dormers','Dormer',(cx,yy,10.16),(3.8,2,1.6),'ivory')
        box('Roof | Dormers','Dormer window',(cx,yy-1.025,10.28),(2.7,.08,.98),'glass')
        for dx in (-1.38,0,1.38):box('Roof | Dormers','Dormer frame',(cx+dx,yy-1.10,10.28),(.13,.18,1.12),'teal')
        for tier in range(3):box('Roof | Dormers','Dormer cap',(cx,yy,11.04+tier*.24),(4.3-tier*1.05,2.5,.26),base)
for tier in range(5):
    box('Roof | Tower cap','Gold stepped cap',(0,6.2,13.32+tier*.46),(8.5-tier*1.55,6.7-tier*1.15,.48),'yellow')
box('Roof | Tower cap','Flag mast',(0,6.2,16.23),(.13,.13,2.4),'navy')
box('Roof | Tower cap','School flag',(.85,6.2,16.78),(1.7,.12,.88),'teal')
box('Roof | Tower cap','Flag emblem',(.85,6.12,16.78),(.4,.05,.4),'yellow')

# Wide, permanently open main entry, canopy and identity.
for x in (-4.4,4.4):box('Entrance | Canopy','Entry column',(x,-.02,1.8),(.55,.55,3.6),'teal',True)
for x in (-4.4,4.4):
    for k in range(4):box('Entrance | Canopy','Column block',(x,-.02,.42+k*.86),(.72,.72,.75),'teal' if k%2 else 'yellow')
box('Entrance | Canopy','Canopy',(0,.55,3.82),(10.8,4.25,.42),'yellow')
for x in range(-4,5):cylinder('Entrance | Canopy',(x,-1.1,4.1),.28,.19,'yellow',8)
box('Entrance | Sign','School sign',(0,1.61,5.02),(8.1,.3,.83),'navy')
text('CRAFTYAP  SCHOOL',(0,1.435,5.02),.53,'white')
text('LEARN  /  BUILD  /  PLAY',(0,-1.60,3.8),.24,'navy')
box('Entrance | Lobby','Welcome inset',(0,8.7,.014),(5,2.2,.028),'yellow')
text('WELCOME',(0,8.7,.035),.57,'navy',(0,0,0))
text('01',(0,2.8,.035),.8,'navy',(0,0,0))

# Switchback stair: 22 x 0.20 m risers, 2.4 m flights and a 2 m side passage.
for i in range(11):
    yy=10.8+(i+.5)*.4;top=(i+1)*.2
    box('Circulation | Stair treads','Stair 0A',(-2.4,yy,top/2),(2.4,.4,top),'wood')
    box('Circulation | Stair treads','Tread edge',(-2.4,yy-.17,top+.006),(2.4,.055,.012),'yellow')
    yy2=15.2-(i+.5)*.4;top2=2.2+(i+1)*.2
    box('Circulation | Stair treads','Stair 0B',(.4,yy2,(top2+2.05)/2),(2.4,.4,top2-2.05),'wood')
    box('Circulation | Stair treads','Tread edge',(.4,yy2+.17,top2+.006),(2.4,.055,.012),'yellow')
box('Circulation | Structure','Mid landing',(-1,16.4,2.08),(5.6,2.4,.24),'wood',True)
box('Circulation | Structure','Upper stair threshold',(.4,10.6,4.26),(2.8,.4,.28),'paper',True)
box('Circulation | Storage','Closed under-stair storage',(.4,14.1,1.025),(2.4,6.6,2.05),'ivory',True)
box('Circulation | Storage','Closed landing base',(-1,16.4,.98),(5.6,2.4,1.96),'ivory',True)
box('Circulation | Storage','Storage door',(.4,10.75,1.05),(1.8,.08,1.9),'teal')
text('STORAGE',(.4,10.69,1.5),.23,'white')
ramps.extend([
 {'name':'Stair flight A','axis':'y','min':[-3.6,10.8,0],'max':[-1.2,15.2,2.2],'start':0,'end':2.2,'direction':1},
 {'name':'Stair flight B','axis':'y','min':[-.8,10.8,2.2],'max':[1.6,15.2,4.4],'start':4.4,'end':2.2,'direction':-1}])
for xx in (-3.65,-1.15):
    beam('Circulation | Rails',(xx,10.8,1.05),(xx,15.2,3.25),.11,'teal')
    for i in range(6):box('Circulation | Rails','Stair baluster',(xx,10.8+i*.88,i*.44+.5),(.08,.08,1),'teal')
for xx in (-.85,1.65):
    beam('Circulation | Rails',(xx,15.2,3.25),(xx,10.8,5.45),.11,'teal')
    for i in range(6):box('Circulation | Rails','Stair baluster',(xx,15.2-i*.88,2.7+i*.44),(.08,.08,1),'teal')
rail('Circulation | Rails',-3.65,1.65,17.5,17.5,2.2)
for xx in (-3.65,-1.15):boxes.append({'name':'Lower stair guard','min':[xx-.05,10.8,0],'max':[xx+.05,15.2,3.3]})
for xx in (-.85,1.65):boxes.append({'name':'Upper stair guard','min':[xx-.05,10.8,2.2],'max':[xx+.05,15.2,5.5]})
boxes.append({'name':'Mid landing guard','min':[-3.7,17.45,2.2],'max':[1.7,17.55,3.3]})
# Upper void guards; keep both the stair exit and circulation routes open.
rail('Circulation | Rails',-4,-4,10.5,18,4.4)
rail('Circulation | Rails',1.85,1.85,10.5,18,4.4)
rail('Circulation | Rails',-4,-1.0,10.5,10.5,4.4)
rail('Circulation | Rails',-4,1.85,18,18,4.4)
for xx,yy,sx,sy in [(-4,14.25,.12,7.5),(1.85,14.25,.12,7.5),(-2.5,10.5,3,.12),(-1.075,18,5.85,.12)]:
    boxes.append({'name':'Atrium safety guard','min':[xx-sx/2,yy-sy/2,4.4],'max':[xx+sx/2,yy+sy/2,5.5]})
text('UPSTAIRS',(0,9.5,.035),.4,'teal',(0,0,0))
text('02',(0,7.3,4.435),.8,'navy',(0,0,0))

def desk(g,x,y,z,kind='desk'):
    box(g,'Desktop',(x,y,z+.77),(1.20,.70,.12),'wood')
    for dx in (-.52,.52):
        for dy in (-.23,.23):box(g,'Desk leg',(x+dx,y+dy,z+.36),(.075,.075,.72),'teal')
    box(g,'Chair seat',(x,y+.85,z+.45),(.62,.61,.12),'yellow')
    box(g,'Chair back',(x,y+1.10,z+.86),(.62,.10,.67),'yellow')
    for dx in (-.23,.23):
        for dy in (.63,1.08):box(g,'Chair leg',(x+dx,y+dy,z+.20),(.065,.065,.4),'teal')
    boxes.append({'name':kind,'min':[x-.61,y-.36,z],'max':[x+.61,y+1.16,z+1.2]})
def board(g,x,y,z,w=5):
    box(g,'Blackboard border',(x,y,z+1.95),(w+.2,.18,1.72),'wood')
    box(g,'Blackboard',(x,y-.105,z+1.95),(w,.035,1.51),'chalk')
    box(g,'Chalk shelf',(x,y-.2,z+1.13),(w+.18,.3,.08),'white')
    for i,length in enumerate((2.3,3.4,1.8)):
        box(g,'Chalk writing',(x-.4,y-.13,z+2.3-i*.3),(length,.012,.025),'paper')
def shelf(g,x,y,z,w=2.1):
    box(g,'Bookcase back',(x,y,z+1.15),(w,.18,2.3),'wood')
    for zz in (.1,.78,1.46,2.2):box(g,'Shelf',(x,y-.23,z+zz),(w,.62,.10),'darkwood')
    for dx in (-w/2+.06,w/2-.06):box(g,'Case upright',(x+dx,y-.2,z+1.15),(.12,.66,2.3),'wood')
    for row in range(3):
        for k in range(7):
            box(g,'Book',(x-w/2+.25+k*.25,y-.24,z+.42+row*.69),(.16,.35,random.uniform(.36,.5)),random.choice(['teal','red','yellow','paper','purple']))
    boxes.append({'name':'Bookcase','min':[x-w/2,y-.55,z],'max':[x+w/2,y+.15,z+2.3]})

rooms=[(-24,-14.25,'101 CLASSROOM','class',0),(-14.25,-4.2,'102 CLASSROOM','class',0),
       (4.2,14.25,'103 LIBRARY','library',0),(14.25,24,'104 DINING','dining',0),
       (-24,-14.25,'201 SCIENCE','science',1),(-14.25,-4.2,'202 CLASSROOM','class',1),
       (4.2,14.25,'203 ART STUDIO','art',1),(14.25,24,'204 COMPUTER','computer',1)]
for a,b,label,kind,level in rooms:
    z=level*4.4;cx=(a+b)/2;g=f'Level {level} | {label}'
    door= -16 if a==-24 else -6.1 if b==-4.2 else 6.1 if a==4.2 else 16
    doorway(g,door,6.7,z,label,'orange' if level else 'teal')
    room_info.append({'id':label,'type':kind,'floor':level,'bounds':[a,6.7,b,22],'entry':[door,6.7,z]})
    box(g,'Floor inset',(cx,14.3,z-.006),(b-a-.5,14.3,.012),'paper')
    # Board is on the rear wall, desks face north with generous aisles.
    if kind in ('class','science','computer'):
        board(g,cx,21.73,z,5)
        for dx in (-2.45,0,2.45):
            for yy in (10.2,13.2,16.2):
                desk(g,cx+dx,yy,z,kind+' desk')
                if kind=='computer':
                    box(g,'Monitor',(cx+dx,yy+.02,z+1.18),(.85,.13,.58),'navy')
                    box(g,'Display',(cx+dx,yy-.055,z+1.18),(.73,.015,.45),'teal_light')
                    box(g,'Monitor stand',(cx+dx,yy,z+.90),(.12,.16,.2),'metal')
                elif kind=='science':
                    box(g,'Lab tray',(cx+dx,yy,z+.86),(.7,.38,.06),'white')
                    cylinder(g,(cx+dx-.2,yy,z+1.04),.09,.32,'water',8)
                    cylinder(g,(cx+dx+.17,yy,z+1.0),.12,.23,'purple',8)
        desk(g,cx,19.3,z,'Teacher desk')
        text('MAKE  /  EXPLORE',(cx,21.59,z+2.30),.30,'white')
        shelf(g,a+1.5,21.52,z,2)
    elif kind=='library':
        for xx in (a+1.5,b-1.5):
            for yy in (12,16,20):shelf(g,xx,yy,z,2.1)
        for yy in (11,16):
            box(g,'Reading table',(cx,yy,z+.77),(2.7,1.55,.14),'wood',True)
            for xx in (cx-1,cx+1):
                for sy in (-1,1):
                    box(g,'Reading stool',(xx,yy+sy*1.3,z+.28),(.65,.65,.56),'teal',True)
        text('READ  /  IMAGINE',(cx,21.78,z+2.9),.40,'teal')
    elif kind=='dining':
        for yy in (11,15.5):
            box(g,'Dining table',(cx,yy,z+.78),(5,1.4,.14),'wood',True)
            for sy in (-1,1):box(g,'Dining bench',(cx,yy+sy*1.2,z+.45),(5,.65,.20),'yellow',True)
        box(g,'Serving counter',(cx,20.2,z+.6),(7,1,1.2),'teal',True)
        box(g,'Countertop',(cx,20.2,z+1.25),(7.2,1.25,.13),'white')
        for dx in (-2,0,2):box(g,'Food tray',(cx+dx,20.2,z+1.36),(.85,.65,.1),'orange')
        text('FUEL  FOR  BIG  IDEAS',(cx,21.78,z+2.65),.33,'teal')
    else:
        for xx in (cx-2.1,cx+2.1):
            for yy in (11,16):
                box(g,'Art table',(xx,yy,z+.8),(2.4,1.4,.14),'wood',True)
                for dx in (-.7,.7):box(g,'Art stool',(xx+dx,yy+1.25,z+.3),(.65,.65,.6),'orange',True)
                for dx,ma in [(-.5,'teal'),(0,'yellow'),(.5,'red')]:cylinder(g,(xx+dx,yy,z+.97),.13,.22,ma,8)
        for dx,ma in [(-2.5,'teal'),(0,'yellow'),(2.5,'orange')]:
            box(g,'Art frame',(cx+dx,21.72,z+2.1),(1.9,.14,2),'wood')
            box(g,'Art canvas',(cx+dx,21.61,z+2.1),(1.7,.06,1.8),'white')
            box(g,'Block painting',(cx+dx,21.565,z+2.15),(.9,.025,1.1),ma)

# Outdoor play: blue half courts, central path, pixel trees and benches.
box('Campus | Court','Court surface',(17,-20,.035),(23,22,.07),'court',True)
for yy in (-25,-15):box('Campus | Court','Blue key',(17,yy,.08),(8,8,.02),'court_blue')
for xx in (5.7,28.3):box('Campus | Court','Court sideline',(xx,-20,.10),(.10,21.5,.025),'white')
for yy in (-30.7,-20,-9.3):box('Campus | Court','Court line',(17,yy,.10),(22.6,.10,.025),'white')
for yy,sgn in [(-30,1),(-10,-1)]:
    box('Campus | Court','Basket post',(17,yy,1.65),(.18,.18,3.3),'navy',True)
    box('Campus | Court','Backboard',(17,yy+sgn*.25,3.3),(2.1,.16,1.35),'white')
    box('Campus | Court','Backboard target',(17,yy+sgn*.35,3.28),(.75,.03,.5),'orange')
    # Square block hoop, without tubes or curves.
    for dx in (-.39,.39):box('Campus | Court','Hoop side',(17+dx,yy+sgn*.75,2.96),(.09,.80,.08),'orange')
    box('Campus | Court','Hoop front',(17,yy+sgn*1.12,2.96),(.86,.09,.08),'orange')
# Center-circle as a low polygon ring.
for i in range(24):
    a=i*math.tau/24;b=(i+1)*math.tau/24
    beam('Campus | Court',(17+2.9*math.cos(a),-20+2.9*math.sin(a),.11),(17+2.9*math.cos(b),-20+2.9*math.sin(b),.11),.09,'white')
text('PLAY',(17,-20,.14),1.2,'white',(0,0,0))
def tree(x,y,scale=1):
    box('Campus | Trees','Tree trunk',(x,y,1.35*scale),(.7*scale,.7*scale,2.7*scale),'trunk',True)
    for loc,sz,mat in [((0,0,3.8),(3.8,3.5,2.2),'leaf'),((-.7,.1,5),(2.5,2.6,1.5),'leaf_light'),((1.2,.3,3.8),(1.8,2.7,1.8),'grass_light')]:
        box('Campus | Trees','Block foliage',(x+loc[0]*scale,y+loc[1]*scale,loc[2]*scale),tuple(a*scale for a in sz),mat)
    for dx in (-.8,.8):
        for dy in (-.7,.7):cylinder('Campus | Trees',(x+dx*scale,y+dy*scale,5.86*scale),.25*scale,.20*scale,'leaf_light',8)
    box('Campus | Landscape','Tree planter',(x,y,.23),(4.4*scale,4.1*scale,.46),'cream',True)
    box('Campus | Landscape','Soil',(x,y,.47),(4*scale,3.7*scale,.04),'grass')
for x,y,s in [(-30,-27,1.05),(-28,-10,1),(-32,6,.95),(-32,23,1.1),(32,4,1),(32,23,1.05),(-19,29,.9),(19,29,.9)]:tree(x,y,s)
def bench(x,y):
    box('Campus | Benches','Bench seat',(x,y,.56),(3.4,.75,.16),'wood',True)
    box('Campus | Benches','Bench back',(x,y+.36,1.08),(3.4,.15,.85),'wood',True)
    for dx in (-1.25,1.25):box('Campus | Benches','Bench base',(x+dx,y,.27),(.24,.65,.54),'teal')
for x,y in [(-17,-9),(-17,-16),(-17,-25),(10,26),(-10,26)]:bench(x,y)
for x,y in [(-23,-16),(-23,-25),(-9,-9),(-9,-25)]:
    box('Campus | Landscape','Flower bed',(x,y,.25),(2.7,2.3,.5),'cream',True)
    box('Campus | Landscape','Bed grass',(x,y,.52),(2.45,2.05,.06),'leaf')
    for dx in (-.65,.65):
        for dy in (-.5,.5):
            box('Campus | Landscape','Flower stem',(x+dx,y+dy,.77),(.10,.1,.5),'leaf')
            box('Campus | Landscape','Pixel flower',(x+dx,y+dy,1.02),(.43,.43,.21),random.choice(['yellow','red','white']))
# Front boundary with a 6 m wide gate aligned to the entrance.
for a,b in [(-37,-3.5),(3.5,37)]:
    rail('Campus | Boundary',a,b,-34,-34,0)
    boxes.append({'name':'Boundary fence','min':[a,-34.1,0],'max':[b,-33.9,1.1]})
for x in (-3.6,3.6):
    box('Campus | Boundary','Gate pillar',(x,-33.9,1.2),(.65,.65,2.4),'teal',True)
    cylinder('Campus | Boundary',(x,-33.9,2.53),.31,.22,'yellow',8)
# A little school emblem and outdoor orientation board.
box('Campus | Sign','School wayfinding',(-6.2,-31,1.35),(3.2,.22,2.5),'navy',True)
text('CRAFTYAP',(-6.2,-31.13,1.9),.4,'white')
text('BLOCK SCHOOL',(-6.2,-31.13,1.35),.27,'yellow')
text('01  LEARN',(-6.2,-31.13,.88),.23,'white')

# Friendly maker-garden: oversized bricks, a mascot block, warm village lanterns.
for x,y,z,mat in [(-16,-21,.65,'teal'),(-14.3,-21,.65,'yellow'),(-12.6,-21,.65,'red'),(-15.15,-21,1.95,'yellow'),(-13.45,-21,1.95,'blue'),(-14.3,-21,3.25,'teal')]:
    box('Campus | Maker garden','Giant building brick',(x,y,z),(1.55,1.55,1.25),mat,True)
    for dx in (-.38,.38):
        for dy in (-.38,.38):cylinder('Campus | Maker garden',(x+dx,y+dy,z+.72),.23,.20,mat,8)
box('Entrance | Mascot','Mascot plinth',(-7,-3.2,.25),(3.5,3,.5),'teal',True)
box('Entrance | Mascot','Smiling block',(-7,-3.2,1.7),(2.45,2,2.4),'yellow',True)
for dx in (-.57,.57):box('Entrance | Mascot','Mascot eye',(-7+dx,-4.23,1.95),(.21,.06,.36),'navy')
box('Entrance | Mascot','Mascot smile',(-7,-4.23,1.38),(.73,.06,.15),'navy')
for dx in (-.55,.55):cylinder('Entrance | Mascot',(-7+dx,-3.2,3.02),.30,.27,'yellow',12)
for xx,yy in [(-4.6,-26),(4.6,-26),(-4.6,-15),(4.6,-15),(-26,1),(26,1)]:
    box('Campus | Lanterns','Lantern base',(xx,yy,.22),(.7,.7,.44),'cream',True)
    box('Campus | Lanterns','Lantern post',(xx,yy,1.47),(.18,.18,2.5),'darkwood')
    box('Campus | Lanterns','Lantern frame',(xx,yy,2.77),(.66,.66,.85),'navy')
    box('Campus | Lanterns','Warm lantern',(xx,yy,2.77),(.48,.48,.63),'yellow')
    box('Campus | Lanterns','Lantern cap',(xx,yy,3.23),(.88,.88,.18),'teal')

# Apply the construction-village art pass before batching the game meshes.
exec(compile(Path(__file__).with_name('school_style.py').read_text(encoding='utf-8'),'school_style.py','exec'))
camera_boxes[:]=[b for b in camera_boxes if b['group'] in groups and (b['group']!='Roof | Main' or b['name']=='Roof deck')]
exec(compile(Path(__file__).with_name('school_finish.py').read_text(encoding='utf-8'),'school_finish.py','exec'))
exec(compile(Path(__file__).with_name('school_surface.py').read_text(encoding='utf-8'),'school_surface.py','exec'))
# Each module is one editable mesh. Flat faces keep the block silhouette.
mesh_objs=[]
for group,(verts,faces,mi) in groups.items():
    mesh=bpy.data.meshes.new(group);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(group,mesh);root.objects.link(obj)
    for mat in materials:mesh.materials.append(mat)
    for poly,m in zip(mesh.polygons,mi):poly.material_index=m
    uv=mesh.uv_layers.new(name='Metre grain UV')
    for polygon in mesh.polygons:
        normal=polygon.normal;axis=max(range(3),key=lambda k:abs(normal[k]));axes=[k for k in range(3)if k!=axis]
        for loop in polygon.loop_indices:
            p=mesh.vertices[mesh.loops[loop].vertex_index].co;uv.data[loop].uv=(p[axes[0]]*2,p[axes[1]]*2)
    obj['asset']='craftyap-block-school';obj['module']=group
    # Tiny edge bevels echo the existing helicopter's moulded ABS blocks.
    if 'Structure' not in group and 'Ground' not in group and 'glazing' not in group and 'Paving' not in group and 'studs' not in group.lower():
        bevel=obj.modifiers.new('Soft toy-block edges','BEVEL');bevel.width=.045 if ('brick' in group.lower() or 'house' in group.lower()) else .025;bevel.segments=2 if 'Assembled ABS' in group else 1;bevel.affect='EDGES'
    mesh_objs.append(obj)
# Export signs as meshes in the deliverable, with text still reproducible in this script.
for obj in list(root.objects):
    if obj.type=='FONT':
        bpy.context.view_layer.objects.active=obj
        obj.select_set(True)
        bpy.ops.object.convert(target='MESH')
        obj.select_set(False)

# Bake a static copy of the user's existing aircraft, with the exact original materials.
heli_path=Path('C:/craftyap/apps/client/public/models/machines/skylark.glb')
if heli_path.exists():
    old=set(scene.objects);bpy.ops.import_scene.gltf(filepath=str(heli_path))
    imported=[o for o in scene.objects if o not in old];bpy.context.view_layer.update();dg=bpy.context.evaluated_depsgraph_get()
    anchor=bpy.data.objects.new('Skylark | Existing CraftYap helicopter',None);root.objects.link(anchor)
    clones=[]
    for ob in imported:
        if ob.type=='MESH' and not ob.hide_render:
            mesh=bpy.data.meshes.new_from_object(ob.evaluated_get(dg),preserve_all_data_layers=True,depsgraph=dg)
            clone=bpy.data.objects.new('Skylark / '+ob.name,mesh);root.objects.link(clone);clone.matrix_world=ob.matrix_world;clone.parent=anchor;clones.append(clone)
    for ob in imported:bpy.data.objects.remove(ob,do_unlink=True)
    for ob in scene.objects:ob.select_set(False)
    for ob in clones:ob.select_set(True)
    if clones:
        bpy.context.view_layer.objects.active=clones[0];bpy.ops.object.join();bpy.context.object.name='Skylark | Original static display'
    anchor.location=(-17,-23,.15)

def make_ramp_mesh(r):
    x0,y0,z0=r['min'];x1,y1,z1=r['max'];a=r['start'];b=r['end'];bottom=min(a,b)-.20
    return [(x0,y0,bottom),(x1,y0,bottom),(x1,y1,bottom),(x0,y1,bottom),(x0,y0,a),(x1,y0,a),(x1,y1,b),(x0,y1,b)],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
cv=[];cf=[]
for entry in boxes:
    mn,mx=entry['min'],entry['max'];n=len(cv)
    cv.extend(tuple((mn[i]+mx[i])/2+v[i]*(mx[i]-mn[i])/2 for i in range(3)) for v in CUBE_VERTS)
    cf.extend(tuple(n+i for i in f) for f in CUBE_FACES)
for r in ramps:
    vv,ff=make_ramp_mesh(r);n=len(cv);cv.extend(vv);cf.extend(tuple(n+i for i in f) for f in ff)
cm=bpy.data.meshes.new('School collision mesh');cm.from_pydata(cv,[],cf);cm.update()
co=bpy.data.objects.new('School_COLLISION',cm);collision_col.objects.link(co);co.display_type='WIRE';co.hide_render=True
co['usage']='Static triangle-mesh collision. Do not use a single convex hull.'

spawn=(0,-29,0)
for name,loc in [('Spawn_Main',spawn),('Entry_Main',(0,2,0)),('Stair_Lower',(-2.4,10,0)),('Stair_Upper',(.4,10,4.4))]:
    ob=bpy.data.objects.new(name,None);root.objects.link(ob);ob.location=loc;ob.empty_display_type='ARROWS';ob.empty_display_size=.6

collision_data={'asset':'craftyap-block-school','version':'1.0.0','units':'metres','coordinateSystem':'Blender Z-up; game=[x,z,-y]',
 'player':{'height':1.8,'width':.6,'depth':.6,'shape':'AABB (Craft mode)','eyeHeight':1.55,'safeProbeHalfWidth':.35,'stepUp':.51,'gravity':24,'jumpSpeed':8.6,'walkSpeed':2.7,'runSpeed':5.2},
 'camera':{'defaultDistance':8,'minimumPreferredDistance':.55,'shoulder':.28,'wallMargin':.32,'hardMargin':.14,'nearClearHalfSize':.22,'probeSpread':.28,'verticalFov':70,'runningFovExtra':5.5},
 'spawn':list(spawn),'boxes':boxes,'cameraBoxes':camera_boxes,'ramps':ramps,'portals':portals,'rooms':room_info,
 'notes':['Boxes are AABB in Blender coordinates. Convert all 8 corners before recomputing a game-space AABB.',
          'Stairs use smooth collision ramps. Visual treads are not included in the collision boxes.',
          'Imported visual GLB does not enable physics by itself. Register the collision mesh or JSON with the engine.']}
(OUT/'school-collision.json').write_text(json.dumps(collision_data,ensure_ascii=False,indent=2),encoding='utf-8')

def camera(name,loc,target,ortho=None,lens=28):
    dat=bpy.data.cameras.new(name);ob=bpy.data.objects.new(name,dat);studio.objects.link(ob);ob.location=loc
    ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler();dat.lens=lens;dat.clip_end=500
    if ortho:dat.type='ORTHO';dat.ortho_scale=ortho
    return ob
cam=camera('Camera | Campus hero',(67,-91,66),(0,-.5,3.7),94)
cam_in=camera('Camera | Corridor',(-20,4.3,1.75),(3,4.5,1.7),None,21)
cam_class=camera('Camera | Classroom',(-16.4,8.3,2.8),(-19,17,1.4),None,20)
cam_stair=camera('Camera | Stairs',(0,8.2,2.2),(0,14.8,3.4),None,19)
scene.camera=cam
world=bpy.data.worlds.new('School daylight');scene.world=world;world.use_nodes=True
world.node_tree.nodes['Background'].inputs['Color'].default_value=(.48,.73,1,1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value=.85
sun_data=bpy.data.lights.new('Afternoon sun','SUN');sun_data.energy=2.8;sun_data.angle=math.radians(12)
sun=bpy.data.objects.new('Afternoon sun',sun_data);studio.objects.link(sun);sun.rotation_euler=(math.radians(27),math.radians(-24),math.radians(-30))
for name,loc,power,size in [('Sky softbox',(0,-8,45),4200,45),('Interior fill',(0,12,12),1600,25)]:
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size
    ob=bpy.data.objects.new(name,d);studio.objects.link(ob);ob.location=loc
for name,loc,power,size in [('Atrium ceiling',(-1,14,8.4),1000,5),('Stair entry fill',(-2.4,9.8,3.7),150,3)]:
    d=bpy.data.lights.new(name,'AREA');d.energy=power;d.shape='DISK';d.size=size
    ob=bpy.data.objects.new(name,d);studio.objects.link(ob);ob.location=loc
# Ceiling lights support interior previews without becoming game meshes.
for lev in range(2):
    for xx in (-19,-9.3,9.3,19):
        for yy in (4.5,12,19):
            d=bpy.data.lights.new('Room illumination','AREA');d.energy=280;d.shape='DISK';d.size=4
            ob=bpy.data.objects.new('Room illumination',d);studio.objects.link(ob);ob.location=(xx,yy,lev*4.4+3.93)
scene.render.engine='CYCLES';scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.threads_mode='FIXED';scene.render.threads=6
scene.render.resolution_x=1600;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
try:
    scene.view_settings.view_transform='Khronos PBR Neutral'
    scene.view_settings.look='None'
except (TypeError,ValueError):pass
scene.render.image_settings.file_format='PNG'
scene.render.film_transparent=False

# Export only asset nodes, excluding preview rig and collision helpers.
def select_objects(obs):
    for o in scene.objects:o.select_set(False)
    for o in obs:o.select_set(True)
    if obs:bpy.context.view_layer.objects.active=obs[0]
assets=list(root.objects)
select_objects(assets)
bpy.ops.export_scene.gltf(filepath=str(OUT/'school.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_extras=True,export_yup=True,export_apply=True)
texture_dir=OUT/'textures';texture_dir.mkdir(exist_ok=True)
for i,img in enumerate([im for im in bpy.data.images if im.has_data and im.type=='IMAGE']):
    img.filepath_raw=str(texture_dir/('school-texture-'+str(i)+'.png'));img.file_format='PNG';img.save();img.pack()
bpy.ops.export_scene.fbx(filepath=str(OUT/'school.fbx'),use_selection=True,object_types={'MESH','EMPTY'},axis_forward='-Z',axis_up='Y',apply_unit_scale=True,add_leaf_bones=False,bake_anim=False,path_mode='COPY',embed_textures=True)
co.hide_set(False);select_objects([co]);co.hide_render=False
bpy.ops.export_scene.gltf(filepath=str(OUT/'school-collision.glb'),export_format='GLB',use_selection=True,use_active_scene=True,export_yup=True)
co.hide_render=True;co.hide_set(True)
select_objects([])
scene.camera=cam
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_perspective='CAMERA'
            area.spaces.active.clip_end=500
scene['asset_notes']='Walkable block school. Doors are open, stairs have matching ramp collision. See README_KO.md.'
scene['build_script']='build_school.py'
scene.render.filepath=str(OUT/'school-preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'CraftYap_School.blend'))
dg=bpy.context.evaluated_depsgraph_get()
stats={'meshObjects':sum(o.type=='MESH' for o in assets),'vertices':sum(len(o.evaluated_get(dg).data.vertices) for o in assets if o.type=='MESH'),'triangles':sum(sum(len(p.vertices)-2 for p in o.evaluated_get(dg).data.polygons) for o in assets if o.type=='MESH'),'collisionBoxes':len(boxes),'ramps':len(ramps),'rooms':len(room_info),'boundsMetres':[78,70,17.5],'style':'Skylark lagoon ABS + signal gold + warm white; stepped block-village roofs'}
(OUT/'asset-info.json').write_text(json.dumps(stats,indent=2),encoding='utf-8')
print('SCHOOL_EXPORTED',json.dumps(stats),flush=True)
if '--skip-render' in sys.argv:sys.exit(0)
for name,camob,res in [('school-preview',cam,(1600,1200)),('school-corridor',cam_in,(1400,900)),('school-classroom',cam_class,(1400,900)),('school-stair',cam_stair,(1200,900))]:
    scene.camera=camob;scene.render.resolution_x,scene.render.resolution_y=res
    scene.render.filepath=str(OUT/(name+'.png'))
    bpy.ops.render.render(write_still=True)
    print('RENDERED',name,flush=True)
print('SCHOOL_DONE',str(OUT),flush=True)
