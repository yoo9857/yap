"""Colour and material detail, attached to existing solid faces, never across openings."""
def finish_box(name,p,s,material):box('Interior | Block finish',name,p,s,material)
def accent_at(x):
    if x<-14.25:return 'teal'
    if x<-4.2:return 'yellow'
    if x<4.2:return 'teal'
    if x<14.25:return 'blue'
    return 'red'
for wall in list(boxes):
    if wall['name'] not in ('Wall','Room division','Central hall division'):continue
    a,b=wall['min'],wall['max'];sizes=[b[k]-a[k] for k in range(3)]
    axis=0 if sizes[0]<=.3 else 1 if sizes[1]<=.3 else None
    if axis is None:continue
    u=1-axis;lo,hi=a[u],b[u];z0,z1=a[2],b[2]
    def stripe(u0,u1,v0,v1,col,side,depth=.008):
        if u1-u0<.006 or v1-v0<.006:return
        p=[0.,0.,(v0+v1)/2];s=[0.,0.,v1-v0];p[axis]=(a[axis]if side<0 else b[axis])+side*.003;p[u]=(u0+u1)/2;s[axis]=depth;s[u]=u1-u0
        finish_box('Moulded wall joint'if col=='cream'else'Room colour band',p,s,col)
    for side in (-1,1):
        level=math.floor((z0+.001)/4.4)*4.4
        x=(a[0]+b[0])/2 if axis==1 else (a[0]if side<0 else b[0])+side*.05
        stripe(lo+.003,hi-.003,max(z0,level+.10),min(z1,level+.62),accent_at(x),side,.014)
        stripe(lo+.003,hi-.003,max(z0,level),min(z1,level+.09),'teal',side,.016)
        row=math.floor(z0/.55)
        while row*.55<z1:
            z=row*.55
            stripe(lo,hi,max(z0,z-.009),min(z1,z+.009),'cream',side)
            x0=math.floor((lo-(.625 if row%2 else 0))/1.25)*1.25+(.625 if row%2 else 0)
            while x0<hi:
                stripe(max(lo,x0-.008),min(hi,x0+.008),max(z0,z+.01),min(z1,z+.54),'cream',side)
                x0+=1.25
            row+=1

# Solid floor caps meet the physical floor exactly. Their coplanar undersurface
# is resolved before export; the player never bobs over a visual-only tile.
for room in room_info:
    a,front,b,rear=room['bounds'];floor=room['floor']*4.4
    nx=max(1,int((b-a-.4)/1.4));ny=max(1,int((rear-front-.4)/1.4));sx=(b-a-.4)/nx;sy=(rear-front-.4)/ny
    for i in range(nx):
        for j in range(ny):
            colour=['tile_cream','paper','tile_sand','tile_cream'][(i*7+j*3+room['floor'])%4]
            if j==0 and i%3==0:colour=accent_at((a+b)/2)
            elif (i+j*2)%13==0:colour='tile_teal'if (a+b)<0 else'tile_blue'
            box('Interior | Floor tiles','Interlocking floor tile',(a+.2+(i+.5)*sx,front+.2+(j+.5)*sy,floor-.007),(sx-.022,sy-.022,.014),colour)
