"""CraftYap construction-village pass; executed by build_school.py before meshing."""
for key in ['Roof | Village gables','Roof | Village studs','Roof | Dormers','Roof | Block studs']:
    groups.pop(key,None)
g=groups['Roof | Main'];groups['Roof | Main']=[g[0][:8],g[1][:6],g[2][:6]]
# Individual gabled houses, a street of chunky moulded bricks and deep cornices.
bays=[(-24,-14.25,-19.125,'yellow','teal'),(-14.25,-4.2,-9.225,'teal','ivory'),
      (4.2,14.25,9.225,'red','yellow'),(14.25,24,19.125,'blue','teal')]
for index,(a,b,cx,roof,paint) in enumerate(bays):
    wxc=[-19,-9.5,9.5,19][index]
    front=1.1+(.45 if index%2 else -.25)
    for tier in range(6):
        width=b-a+.65-tier*1.58;zz=9.36+tier*.57+(.4 if index in (0,3) else 0)
        box('Roof | Separate brick houses','Roof brick layer',(cx,12,zz),(width,23.2-front,.54),roof)
        for side in (-1,1):
            xx=cx+side*(width/2-.45)
            for yy in range(3,23,2):
                box('Roof | Separate brick houses','Roof tile',(xx,yy,zz+.31),(.92,1.87,.15),roof)
                for dy in (-.47,.47):cylinder('Roof | Large roof studs',(xx,yy+dy,zz+.48),.28,.2,roof,12)
        count=max(1,int(width/1.25));w=width/count
        for k in range(count):box('Roof | Gable brickwork','Gable brick',(cx-width/2+(k+.5)*w,front-.07,zz),(w-.055,.3,.46),roof)
    for level in range(2):
        bz=level*4.4;col=paint if level==0 else ('ivory' if paint!='ivory' else 'teal')
        xs=sorted(set([a,b,wxc-2.5,wxc+2.5]+[a+i*1.6 for i in range(1,8) if a+i*1.6<b]))
        zs=sorted(set([bz,bz+1.15,bz+3.15,bz+4.4]+[bz+i*.88 for i in range(1,5)]))
        for l,r in zip(xs,xs[1:]):
            for lo,hi in zip(zs,zs[1:]):
                if wxc-2.5<(l+r)/2<wxc+2.5 and bz+1.15<(lo+hi)/2<bz+3.15:continue
                if r-l>.08 and hi-lo>.08:box('Exterior | Assembled ABS bricks','Facade brick',((l+r)/2,1.72,(lo+hi)/2),(r-l-.045,.28,hi-lo-.045),col)
        for k in range(5):
            xx=a+(k+.5)*(b-a)/5
            colour='ivory' if level==0 else roof
            box('Exterior | Big construction bricks','Cornice brick',(xx,1.29,bz+4.21),((b-a)/5-.06,1.16,.36),colour)
            for dx in (-.44,.44):cylinder('Exterior | Big cornice studs',(xx+dx,1.29,bz+4.51),.28,.23,colour,12)
    # One pier per shared bay joint; overlapping yellow/ivory piers caused z-fighting.
    for xx in ((a+.2,b) if index in (0,2) else (b-.2,)):
        for k in range(8):box('Exterior | Chunky corner piers','Corner brick',(xx,1.4,.56+k*1.05),(.85,.82,.96),'yellow' if index%2 else 'ivory',True)
    box('Exterior | Gable identity','Gable plaque',(cx,front-.3,10.3),(3.7,.3,1.05),'ivory')
    text(['LEARN','MAKE','READ','CREATE'][index],(cx,front-.475,10.3),.45,'teal')

# Move the maker sculpture and benches away from the actual aircraft footprint.
key='Campus | Maker garden';g=groups[key];g[0][:]=[(x-12,y+2.5,z) for x,y,z in g[0]]
for b in camera_boxes:
    if b['group']==key:
        for k in ('min','max'):b[k][0]-=12;b[k][1]+=2.5
for b in boxes:
    if b['name']=='Giant building brick':
        for k in ('min','max'):b[k][0]-=12;b[k][1]+=2.5
groups.pop('Campus | Benches',None)
boxes[:]=[b for b in boxes if b['name'] not in ('Bench seat','Bench back')]
camera_boxes[:]=[b for b in camera_boxes if b['group']!='Campus | Benches']
for xx,yy in [(-17,-9),(-30,-23),(10,26),(-10,26)]:bench(xx,yy)

# A monumental, visibly assembled front gate and thick construction-brick fence.
for xx in (-4.4,4.4):
    for k in range(4):box('Campus | Brick entrance gate','Gate pillar brick',(xx,-33.6,.48+k*.92),(1.25,1.25,.84),'teal' if k%2 else 'ivory',True)
box('Campus | Brick entrance gate','Entrance header',(0,-33.6,4.15),(10.2,1.35,.72),'yellow',True)
for xx in range(-4,5):cylinder('Campus | Gate studs',(xx,-33.6,4.64),.29,.26,'yellow',12)
text('CRAFTYAP',(0,-34.31,4.15),.63,'navy')
for xx in range(-36,37,4):
    if abs(xx)<6:continue
    box('Campus | Brick fence','Fence base',(xx,-33.8,.14),(3.9,.46,.28),'ivory')
    box('Campus | Brick fence','Fence post',(xx,-33.8,.74),(.42,.55,1.2),'ivory')
    cylinder('Campus | Fence studs',(xx,-33.8,1.43),.26,.20,'yellow',12)

# Lego-like construction plates, with cosmetic studs, surround the small garden.
for xx in range(-24,-5,2):
    for yy in range(-30,-7,2):
        if (-23<xx<-11 and -29<yy<-15) or (-20<xx<-14 and yy>-11):continue
        if any(abs(xx-fx)<2 and abs(yy-fy)<2 for fx,fy in [(-23,-16),(-23,-25),(-9,-9),(-9,-25)]):continue
        box('Campus | Garden base plates','Grass plate',(xx,yy,-.005),(1.96,1.96,.055),'grass')
        for dx in (-.48,.48):
            for dy in (-.48,.48):cylinder('Campus | Grass plate studs',(xx+dx,yy+dy,.065),.19,.1,'grass_light' if (xx+yy)%6==0 else 'grass',8)

# Both small club houses have accessible interiors and open doorways.
for cx,paint,roof,label in [(-33,'teal','yellow','MAKER CLUB'),(33,'ivory','teal','ART CLUB')]:
    g='Campus | '+label
    box(g,'Club floor',(cx,14,.01),(6,6,.08),'paper',True)
    box(g,'Back wall',(cx,17,2.1),(6,.25,4.2),paint,True)
    for xx in (cx-3,cx+3):box(g,'Side wall',(xx,14,2.1),(.25,6,4.2),paint,True)
    opening_wall(g,'X',11,cx-3,cx+3,0,4.2,[[cx-1.15,cx+1.15,0,3.6]],paint)
    for tier in range(5):
        w=6.6-tier*1.18
        box(g,'Club roof layer',(cx,14,4.45+tier*.43),(w,7,.42),roof)
        for xx in (cx-w/2+.3,cx+w/2-.3):
            for yy in (11.3,12.7,14.1,15.5,16.7):cylinder(g,(xx,yy,4.75+tier*.43),.22,.18,roof,8)
    text(label,(cx,10.82,3.94),.33,'navy' if paint=='ivory' else 'white')
    box(g,'Club workbench',(cx,15.4,.77),(3,1.1,1.54),'wood',True)
    for xx in (cx-1,cx,cx+1):box(g,'Club brick',(xx,15.4,1.7),(.65,.6,.35),'yellow' if xx==cx else 'teal')
    portals.append({'label':label,'center':[cx,11,0],'clearWidth':2.3,'clearHeight':3.6})

box('Campus | Aviation courtyard','Helipad',(-17,-22,.06),(10,11,.18),'navy',True)
for xx in (-21.8,-12.2):box('Campus | Aviation courtyard','Helipad rim',(xx,-22,.18),(.25,11,.12),'yellow')
for yy in (-27.3,-16.7):box('Campus | Aviation courtyard','Helipad rim',(-17,yy,.18),(10,.25,.12),'yellow')
text('H',(-17,-22,.165),3.8,'yellow',(0,0,0))
for yy in (-27.3,-16.7):
    for xx in range(-21,-11,2):cylinder('Campus | Aviation studs',(xx,yy,.32),.22,.18,'yellow',8)
boxes.append({'name':'Parked Skylark safety envelope','min':[-20.4,-25.5,.15],'max':[-13.6,-17.9,3.5]})
