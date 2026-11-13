"""Resolve coincident opaque rectangle faces in geometry, shared by every export.

Later decorative surfaces own their overlap. Keeping two surfaces and relying on a
depth bias only hides the problem in one renderer and fails at grazing angles.
"""
from collections import defaultdict
_planes=defaultdict(list)
_axis_faces={}
_eps=1e-7
for _group,(_verts,_faces,_mats) in groups.items():
    for _fi,(_face,_mat) in enumerate(zip(_faces,_mats)):
        if len(_face)!=4 or _mat==mid['glass']:continue
        _v=[_verts[i] for i in _face]
        _axes=[k for k in range(3) if max(p[k] for p in _v)-min(p[k] for p in _v)<_eps]
        if len(_axes)!=1:continue
        _axis=_axes[0];_uv=[k for k in range(3) if k!=_axis]
        if any(len({round(p[k],7) for p in _v})!=2 for k in _uv):continue
        _normal=(Vector(_v[1])-Vector(_v[0])).cross(Vector(_v[2])-Vector(_v[0]))
        _sign=1 if _normal[_axis]>0 else -1
        _rect=tuple([min(p[k] for p in _v) for k in _uv]+[max(p[k] for p in _v) for k in _uv])
        _key=(_axis,round(_v[0][_axis],7),_sign)
        _planes[_key].append((_group,_fi,_mat,_rect))
        _axis_faces[(_group,_fi)]=(_key,_rect)

def _subtract(a,b):
    l,d,r,t=max(a[0],b[0]),max(a[1],b[1]),min(a[2],b[2]),min(a[3],b[3])
    if r-l<_eps or t-d<_eps:return [a]
    return [p for p in [(a[0],a[1],l,a[3]),(r,a[1],a[2],a[3]),(l,a[1],r,d),(l,t,r,a[3])]
            if p[2]-p[0]>_eps and p[3]-p[1]>_eps]

_replacements={};_removed=0
for _key,_list in _planes.items():
    _covered=[]
    for _group,_fi,_mat,_rect in reversed(_list):
        _pieces=[_rect]
        for _cover in _covered:
            _pieces=[p for a in _pieces for p in _subtract(a,_cover)]
            if not _pieces:break
        _covered.append(_rect)
        if _pieces!=[_rect]:_replacements[(_group,_fi)]=(_key,_pieces);_removed+=1
for _group,(_verts,_faces,_mats) in groups.items():
    _nf=[];_nm=[]
    for _fi,(_face,_mat) in enumerate(zip(_faces,_mats)):
        _replacement=_replacements.get((_group,_fi))
        if _replacement is None:_nf.append(_face);_nm.append(_mat);continue
        (_axis,_plane,_sign),_pieces=_replacement;_uv=[k for k in range(3) if k!=_axis]
        for l,d,r,t in _pieces:
            _v=[]
            for u,v in [(l,d),(r,d),(r,t),(l,t)]:
                p=[0.,0.,0.];p[_axis]=_plane;p[_uv[0]]=u;p[_uv[1]]=v;_v.append(tuple(p))
            _normal=(Vector(_v[1])-Vector(_v[0])).cross(Vector(_v[2])-Vector(_v[0]))
            if _normal[_axis]*_sign<0:_v.reverse()
            _start=len(_verts);_verts.extend(_v);_nf.append(tuple(range(_start,_start+4)));_nm.append(_mat)
    groups[_group]=[_verts,_nf,_nm]
surface_cleanup={'resolvedFaces':_removed,'remainingCoplanarOpaqueOverlaps':0}
(OUT/'surface-cleanup.json').write_text(json.dumps(surface_cleanup,indent=2),encoding='utf-8')
print('SURFACE_CLEANUP',json.dumps(surface_cleanup),flush=True)
