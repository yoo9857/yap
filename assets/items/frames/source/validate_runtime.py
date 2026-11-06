"""Audit the bytes of all ten GLBs and compare the unchanged models to v1."""
import hashlib, json, math, struct
from pathlib import Path

ITEMS=next(p for p in Path(__file__).resolve().parents if p.name=='items')
records={}
for group in ('frames','parts'):
    runtime=ITEMS/group/'v2/runtime'
    manifest=json.loads((runtime/'manifest.json').read_text(encoding='utf-8'))
    for name,entry in manifest['files'].items():
        blob=(runtime/name).read_bytes()
        magic,version,total=struct.unpack_from('<III',blob)
        assert magic==0x46546c67 and version==2 and total==len(blob)
        jslen,jstype=struct.unpack_from('<II',blob,12)
        doc=json.loads(blob[20:20+jslen])
        binstart=20+jslen
        binlen,bintype=struct.unpack_from('<II',blob,binstart)
        binary=blob[binstart+8:binstart+8+binlen]
        assert not doc.get('images') and not doc.get('textures')
        roots=doc['scenes'][doc.get('scene',0)]['nodes']
        assert len(roots)==1 and doc['nodes'][roots[0]]['name']==Path(name).stem
        points=[]
        def visit(index,offset=(0,0,0)):
            node=doc['nodes'][index]
            assert 'matrix' not in node and node.get('rotation',[0,0,0,1])==[0,0,0,1]
            assert node.get('scale',[1,1,1])==[1,1,1]
            t=node.get('translation',[0,0,0])
            offset=tuple(a+b for a,b in zip(offset,t))
            if 'mesh' in node:
                assert t==[0,0,0]
                for prim in doc['meshes'][node['mesh']]['primitives']:
                    assert 'NORMAL' in prim['attributes']
                    a=doc['accessors'][prim['attributes']['POSITION']]
                    v=doc['bufferViews'][a['bufferView']]
                    off=v.get('byteOffset',0)+a.get('byteOffset',0)
                    for i in range(a['count']):
                        p=struct.unpack_from('<3f',binary,off+i*v.get('byteStride',12))
                        assert all(math.isfinite(x) for x in p)
                        points.append(tuple(x+y for x,y in zip(p,offset)))
            for child in node.get('children',[]): visit(child,offset)
        visit(roots[0])
        tris=sum(doc['accessors'][p['indices']]['count']//3 for m in doc['meshes'] for p in m['primitives'])
        assert tris==entry['triangle_count'] and tris<=entry['triangle_budget']
        bb={'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]}
        for side in ('min','max'):
            assert all(abs(x-y)<2e-6 for x,y in zip(bb[side],entry['bounding_box'][side]))
        assert entry['node_names']==[n['name'] for n in doc['nodes']]
        records[group+'/'+name]={'triangles':tris,'budget':entry['triangle_budget'],'bounds_verified':True,'root_verified':True,'normals_present':True,'no_textures':True}
baseline=json.loads((ITEMS/'frames/v2/source/unchanged-sha256.json').read_text())
for old,digest in baseline.items():
    new=ITEMS/old.replace('/runtime/','/v2/runtime/')
    assert hashlib.sha256(new.read_bytes()).hexdigest()==digest,old
result={'status':'PASS','runtime_files':records,'unchanged_files_byte_identical':list(baseline)}
(ITEMS/'frames/v2/runtime-validation.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print('PASS: ten GLBs match manifests, roots, bounds, budgets, normals and texture rules; five unchanged GLBs are byte-identical.')
