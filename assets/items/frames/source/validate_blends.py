import bpy, bmesh, json, sys
from pathlib import Path
reports={}
for blend in sys.argv[sys.argv.index('--')+1:]:
    bpy.ops.wm.open_mainfile(filepath=str(Path(blend).resolve()))
    report={}
    for o in bpy.data.objects:
        if o.type!='MESH' or o.parent is None or o.parent.name not in ['part-generator','part-wire-terminal','frame-foundation','frame-foundation-center','frame-tower-base']:
            continue
        if 'frames' in blend and not any(c.name.startswith('FRAME ASSETS') for c in o.users_collection):
            continue
        bm=bmesh.new(); bm.from_mesh(o.data)
        nonmanifold=sum(not e.is_manifold for e in bm.edges)
        degenerate=sum(f.calc_area()<1e-10 for f in bm.faces)
        volume=bm.calc_volume(signed=True)
        report[o.name]={'non_manifold':nonmanifold,'degenerate':degenerate,'volume':round(volume,9)}
        bm.free()
    reports[blend]=report
out=Path(__file__).parent/'mesh-validation.json'
out.write_text(json.dumps(reports,indent=2),encoding='utf-8')
for blend,objects in reports.items():
    problems={k:v for k,v in objects.items() if v['non_manifold'] or v['degenerate'] or v['volume']<0}
    print(blend, 'problems:',json.dumps(problems))
