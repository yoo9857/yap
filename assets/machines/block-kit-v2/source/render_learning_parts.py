import bpy,os,math
from mathutils import Vector
ROOT=os.environ.get('CRAFTYAP_VEHICLE_OUT') or os.path.abspath('outputs/CraftYap_vehicle_blocks_2026-11-03')
scene=bpy.data.scenes.new('Learning Parts');bpy.context.window.scene=scene
source=bpy.data.scenes['Machine Library HQ'];names=['frame','cockpit','wheel','thruster','ballast','gyro','wing','balloon']
bpy.context.window.scene=source;bpy.context.view_layer.update();bpy.context.window.scene=scene
colors={'frame':'E4D6AC','cockpit':'A8DDC8','ballast':'78888A','wheel':'E4D6AC','thruster':'E7B85D','gyro':'8BBFD8','wing':'E4D6AC','balloon':'DA7966'}
def lin(v):return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def rgb(s):return tuple(lin(int(s[i:i+2],16)/255) for i in (0,2,4))
for kind,color in colors.items():
    if bpy.data.materials.get('Preview '+kind):continue
    m=bpy.data.materials['Warm enamel'].copy();m.name='Preview '+kind;p=m.node_tree.nodes.get('Principled BSDF');original=p.inputs['Base Color'].links[0].from_socket;mix=m.node_tree.nodes.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;t=rgb(color);b=rgb('E4D6AC');mix.inputs[2].default_value=(*(t[i]/b[i] for i in range(3)),1);m.node_tree.links.new(original,mix.inputs[1]);m.node_tree.links.new(mix.outputs[0],p.inputs['Base Color'])
for i,kind in enumerate(names):
    root=next(o for o in source.objects if o.get('machinePart')==kind);parent=bpy.data.objects.new('Study '+kind,None);scene.collection.objects.link(parent)
    x=(i%4-1.5)*1.9;y=(i//4-.5)*2.2;parent.location=(x,y,1.23 if kind=='wheel' else .51)
    for src in root.children_recursive:
        o=src.copy();o.data=src.data;scene.collection.objects.link(o);o.parent=parent;o.matrix_basis=src.matrix_basis.copy()
        for slot in o.material_slots:
            if slot.material and slot.material.name=='Warm enamel':slot.link='OBJECT';slot.material=bpy.data.materials['Preview '+kind]
        if kind=='wheel' and o.get('machineRole') in ['body','wheel-hub']:o.location.z-=.65
    bpy.ops.object.text_add(location=(x-.63,y-.67,.02));label=bpy.context.object;label.data.body=kind.upper();label.data.size=.16;label.data.extrude=.001;label.data.materials.append(bpy.data.materials['Soft graphite'])
bpy.ops.mesh.primitive_plane_add(size=200);floor=bpy.context.object;floor.data.materials.append(bpy.data.materials['Backdrop'])
scene.world=bpy.data.worlds['Warm studio']
for name,loc,power,size in [('Study Key',(-4,-5,9),1700,8),('Study Fill',(6,4,7),1500,7)]:
    bpy.ops.object.light_add(type='AREA',location=loc);l=bpy.context.object;l.name=name;l.data.energy=power;l.data.size=size;l.rotation_euler=(Vector((0,0,0))-l.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(7,-10,12));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.3))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=10;scene.camera=cam
scene.render.engine='BLENDER_EEVEE';scene.view_settings.view_transform='AgX';scene.render.resolution_x=1600;scene.render.resolution_y=1000;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.filepath=os.path.join(ROOT,'previews','parts-blender.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source','CraftYap_MachineKit_Learning.blend'))
