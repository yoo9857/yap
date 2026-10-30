import bpy,math,pathlib,json
from mathutils import Vector
ASSET_ROOT=pathlib.Path(globals().get('ASSET_ROOT',pathlib.Path(__file__).resolve().parent.parent))
for folder in ['source','runtime','previews']: (ASSET_ROOT/folder).mkdir(parents=True,exist_ok=True)
scene=bpy.data.scenes.new('CraftYap | Pickaxe Basic');bpy.context.window.scene=scene
scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=1
collection=bpy.data.collections.new('Pickaxe | Editable source');scene.collection.children.link(collection)
root=bpy.data.objects.new('Pickaxe_Basic_Source',None);collection.objects.link(root);root['asset_id']='pickaxe-basic';root['version']='1.0.0'
regions=json.loads((ASSET_ROOT/'textures/atlas-regions.json').read_text())['regions']
mat=bpy.data.materials.new('Pickaxe | Original 512 atlas PBR');mat.use_nodes=True;n=mat.node_tree.nodes;n.clear();links=mat.node_tree.links
out=n.new('ShaderNodeOutputMaterial');shader=n.new('ShaderNodeBsdfPrincipled');links.new(shader.outputs['BSDF'],out.inputs['Surface'])
images=[]
for name in ['albedo','normal','orm']:
 image=bpy.data.images.load(str(ASSET_ROOT/'textures'/('pickaxe-'+name+'.png')),check_existing=False);image.colorspace_settings.name='sRGB' if name=='albedo' else 'Non-Color';images.append(image)
 tex=n.new('ShaderNodeTexImage');tex.image=image;tex.label=name
 if name=='albedo':links.new(tex.outputs['Color'],shader.inputs['Base Color'])
 elif name=='normal':
  normal=n.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.45;links.new(tex.outputs['Color'],normal.inputs['Color']);links.new(normal.outputs['Normal'],shader.inputs['Normal'])
 else:
  separate=n.new('ShaderNodeSeparateColor');links.new(tex.outputs['Color'],separate.inputs['Color']);links.new(separate.outputs['Green'],shader.inputs['Roughness']);links.new(separate.outputs['Blue'],shader.inputs['Metallic'])
parts=[]
def atlas_uv(u,v,region):
 a,b,c,d=regions[region];pad=.015;return (a+pad+(c-a-pad*2)*u,b+pad+(d-b-pad*2)*v)
def mesh_object(name,vertices,faces,uvs,face_regions):
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update();uv=mesh.uv_layers.new(name='UVMap')
 for polygon,coords,region in zip(mesh.polygons,uvs,face_regions):
  for loop,coord in zip(polygon.loop_indices,coords):uv.data[loop].uv=atlas_uv(coord[0],coord[1],region)
  polygon.use_smooth=True
 ob=bpy.data.objects.new(name,mesh);collection.objects.link(ob);ob.parent=root;ob.data.materials.append(mat)
 bevel=ob.modifiers.new('Soft block edges','BEVEL');bevel.width=.006;bevel.segments=2;bevel.limit_method='ANGLE';bevel.angle_limit=.45;bevel.harden_normals=True
 weighted=ob.modifiers.new('Weighted face normals','WEIGHTED_NORMAL');weighted.keep_sharp=True;weighted.weight=50
 parts.append(ob);return ob
def loft(name,profiles,axis,region,cap_region=None):
 vertices=[];faces=[];uvs=[];face_regions=[]
 for along,center,width,depth in profiles:
  points=[(.5,.28),(.28,.5),(-.28,.5),(-.5,.28),(-.5,-.28),(-.28,-.5),(.28,-.5),(.5,-.28)]
  for a,b in points:
   vertices.append((center+a*width,b*depth,along) if axis=='z' else (along,a*width,center+b*depth))
 total=len(profiles)
 for k in range(total-1):
  for j in range(8):
   faces.append((k*8+j,k*8+(j+1)%8,(k+1)*8+(j+1)%8,(k+1)*8+j));uvs.append([(j/8,k/(total-1)),((j+1)/8,k/(total-1)),((j+1)/8,(k+1)/(total-1)),(j/8,(k+1)/(total-1))]);face_regions.append(region)
 for ring,reverse in [(0,True),(total-1,False)]:
  ids=list(range(ring*8,(ring+1)*8));ids=ids[::-1] if reverse else ids;faces.append(ids);uvs.append([(.5+.46*math.cos(i*math.pi/4),.5+.46*math.sin(i*math.pi/4)) for i in (list(range(8))[::-1] if reverse else range(8))]);face_regions.append(cap_region or region)
 return mesh_object(name,vertices,faces,uvs,face_regions)
loft('Handle | honey wood',[(-.27,-.018,.09,.084),(-.21,-.014,.103,.091),(-.08,-.004,.101,.092),(.10,.003,.092,.086),(.31,.014,.082,.079),(.48,.013,.078,.076),(.555,.01,.078,.076)],'z','wood','endgrain')
loft('Grip | soft sage wrap',[(-.13,-.006,.106,.099),(-.112,-.005,.112,.104),(.068,.002,.105,.099),(.085,.003,.099,.094)],'z','grip')
loft('Pommel | warm brass',[(-.285,-.018,.09,.083),(-.273,-.018,.107,.097),(-.248,-.017,.105,.095)],'z','brass')
loft('Eye collar | brass sleeve',[(.425,.014,.112,.134),(.453,.012,.142,.212),(.555,.008,.135,.205)],'z','brass')
loft('Head | curved forged iron',[(-.48,.36,.029,.022),(-.397,.435,.081,.062),(-.25,.508,.143,.108),(-.09,.539,.18,.146),(.07,.54,.184,.15),(.25,.507,.145,.113),(.392,.431,.078,.063),(.468,.352,.024,.018)],'x','iron','edge')
for side in [-1,1]:
 bpy.ops.mesh.primitive_cylinder_add(vertices=10,radius=.025,depth=.009,location=(.007,side*.108,.487),rotation=(math.pi/2,0,0));ob=bpy.context.object;ob.name='Rivet | '+str(side)
 for linked in list(ob.users_collection):linked.objects.unlink(ob)
 collection.objects.link(ob);ob.parent=root;ob.data.materials.append(mat)
 if not ob.data.uv_layers:ob.data.uv_layers.new()
 for uv in ob.data.uv_layers.active.data:uv.uv=atlas_uv(uv.uv.x,uv.uv.y,'edge')
 bevel=ob.modifiers.new('Rivet edge','BEVEL');bevel.width=.003;bevel.segments=2;parts.append(ob)
# Evaluate modifiers into one game mesh while leaving every authoring part editable.
bpy.context.view_layer.update();deps=bpy.context.evaluated_depsgraph_get();exports=bpy.data.collections.new('Pickaxe | Generated runtime');scene.collection.children.link(exports)
clones=[]
for original in parts:
 mesh=bpy.data.meshes.new_from_object(original.evaluated_get(deps),preserve_all_data_layers=True,depsgraph=deps);copy=bpy.data.objects.new(original.name+' export',mesh);exports.objects.link(copy);copy.matrix_world=original.matrix_world.copy();clones.append(copy)
bpy.ops.object.select_all(action='DESELECT')
for ob in clones:ob.select_set(True)
bpy.context.view_layer.objects.active=clones[0];bpy.ops.object.join();game=bpy.context.object;game.name='Pickaxe_Mesh';scene.cursor.location=(0,0,0);bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
# Collapse the identical atlas slots into one draw primitive.
for polygon in game.data.polygons:polygon.material_index=0
game.data.materials.clear();game.data.materials.append(mat)
export_root=bpy.data.objects.new('Pickaxe_Root',None);exports.objects.link(export_root);game.parent=export_root;export_root['asset_id']='pickaxe-basic';export_root['unit']='meter';export_root['grip_node']='Grip_Main'
anchors=[]
for name,location in [('Grip_Main',(0,0,0)),('Grip_Offhand',(.01,0,.255)),('Head_Center',(.008,0,.54)),('Impact_Left',(-.48,0,.36)),('Impact_Right',(.468,0,.352))]:
 ob=bpy.data.objects.new(name,None);exports.objects.link(ob);ob.parent=export_root;ob.location=location;ob.empty_display_size=.035;ob.empty_display_type='ARROWS';anchors.append(ob)
bpy.ops.object.select_all(action='DESELECT')
for ob in [export_root,game]+anchors:ob.select_set(True)
bpy.context.view_layer.objects.active=game
bpy.ops.export_scene.gltf(filepath=str(ASSET_ROOT/'runtime/pickaxe-basic.glb'),export_format='GLB',use_selection=True,export_apply=True,export_extras=True,export_animations=False,export_yup=True)
exports.hide_render=True;exports.hide_viewport=True
# Product renders use the editable model and its real maps.
scene.render.engine='BLENDER_EEVEE';scene.eevee.taa_render_samples=64;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=.3
world=bpy.data.worlds.new('Pickaxe | warm studio');scene.world=world;world.use_nodes=True;world.node_tree.nodes['Background'].inputs['Color'].default_value=(.7,.75,.66,1);world.node_tree.nodes['Background'].inputs['Strength'].default_value=.5
stage=bpy.data.collections.new('Preview studio | excluded from export');scene.collection.children.link(stage)
def move_stage(ob):
 for c in list(ob.users_collection):c.objects.unlink(ob)
 stage.objects.link(ob)
for label,pos,energy,size in [('Key',(-3,-4,5),420,3),('Fill',(3,-2,3),300,3),('Rim',(0,3,4),600,2.5)]:
 bpy.ops.object.light_add(type='AREA',location=pos);ob=bpy.context.object;move_stage(ob);ob.name=label;ob.data.energy=energy;ob.data.shape='DISK';ob.data.size=size;ob.rotation_euler=(Vector((0,0,.15))-ob.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(1.6,-3,1.35));camera=bpy.context.object;move_stage(camera);camera.data.type='ORTHO';camera.data.ortho_scale=1.32;scene.camera=camera
floor_mat=bpy.data.materials.new('Preview floor | sage');floor_mat.diffuse_color=(.36,.45,.35,1);floor_mat.use_nodes=True;floor_mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.36,.45,.35,1);floor_mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.95
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.291));floor=bpy.context.object;move_stage(floor);floor.data.materials.append(floor_mat)
def render(name,position,resolution=(1100,1100),scale=1.32,transparent=False):
 camera.location=position;camera.rotation_euler=(Vector((0,0,.155))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.ortho_scale=scale;scene.render.resolution_x,scene.render.resolution_y=resolution;scene.render.film_transparent=transparent;floor.hide_render=transparent;scene.render.filepath=str(ASSET_ROOT/'previews'/name);bpy.ops.render.render(write_still=True)
render('hero.png',(1.45,-3,1.22))
render('front.png',(0,-4,.155))
render('side.png',(4,-.05,.22))
render('icon.png',(1.3,-3,1.25),(512,512),1.3,True)
render('hero.png',(1.45,-3,1.22))
# Pack maps and keep the source scene portable, with a clean asset-only selection.
for image in images:image.pack()
bpy.ops.object.select_all(action='DESELECT');root.select_set(True);bpy.context.view_layer.objects.active=root
bpy.data.libraries.write(str(ASSET_ROOT/'source/PickaxeBasic.blend'),{scene},path_remap='RELATIVE',fake_user=True)
triangles=sum(len(p.vertices)-2 for p in game.data.polygons)
result={'source':str(ASSET_ROOT/'source/PickaxeBasic.blend'),'runtime':str(ASSET_ROOT/'runtime/pickaxe-basic.glb'),'triangles':triangles,'draw_materials':len(game.data.materials),'anchors':[a.name for a in anchors]}
(ASSET_ROOT/'blender-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
