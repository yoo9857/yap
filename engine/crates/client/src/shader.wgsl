// The terrain, lit like the web's blocks: three.js MeshPhysicalMaterial reduced to what the game
// uses (render/renderer.ts lights, blockMaterials.ts materials), so both renderers agree:
// - a sun (DirectionalLight 0xfff4d6 x 2.0 from (18, 35, 14)) and a sky/ground hemisphere
//   (0xdff3ff / 0x8f8a78 x 1.5); Lambert diffuse + GGX specular (three's BRDF_GGX: Schlick,
//   Smith-correlated visibility, GGX distribution), dielectric F0 0.04 mixed toward the albedo by
//   metalness; three's geometry roughness term against shimmering;
// - per layer (looks.rs layer_params): roughness x map.g, metalness x map.b, normal-map strength,
//   a clearcoat lobe (gem, glass, metal, ore, coat), an emissive glow (glowstone x its picture);
// - normal maps without tangents: three's perturbNormal2Arb (screen-space cotangent frame);
// - Khronos PBR Neutral tone mapping at exposure 1.12, then sRGB, then the fog mixed IN sRGB with
//   a smoothstep factor (meshphysical.glsl: tonemapping -> colorspace -> fog_fragment).
// The sky: the web's SkyDome gradient, tone mapped like its shader.

struct Uniforms {
    view_proj: mat4x4<f32>,
    inv_view_proj: mat4x4<f32>,
    eye: vec4<f32>,
    sun: vec4<f32>,      // xyz: direction toward the sun
    horizon: vec4<f32>,  // fog colour = the sky at the horizon (linear)
    top: vec4<f32>,      // the sky overhead (linear)
    fog: vec4<f32>,      // x: start, y: end (view depth, metres), z: see-through opacity
    focus: vec4<f32>,    // xyz: the LOD/stud focus
    studs: vec4<f32>,    // x: Stud_HQ out to here, y: Stud_LOD1 out to here (metres)
    light: mat4x4<f32>,  // the sun's shadow camera: world -> light clip space
    shadow: vec4<f32>,   // x: one shadow texel (uv), y: depth bias, z: 1 = shadows on
    water: vec4<f32>,    // waterMesh.ts: x uTime, yz uOrigin (field window origin mod 1024)
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var surface_sampler: sampler;
@group(0) @binding(3) var normal_maps: texture_2d_array<f32>;
@group(0) @binding(4) var orm_maps: texture_2d_array<f32>;
// three vec4 per layer: [roughness, metalness, normal strength, clearcoat],
// [emissive rgb, emissive uses the picture], [clearcoat roughness, sky reflection strength, -, -]
@group(0) @binding(5) var<uniform> materials: array<vec4<f32>, 384>;
@group(0) @binding(6) var shadow_map: texture_depth_2d;
@group(0) @binding(7) var shadow_sampler: sampler_comparison;

const PI: f32 = 3.141592653589793;
const RECIPROCAL_PI: f32 = 0.3183098861837907;
const EXPOSURE: f32 = 1.12;
// render/renderer.ts lights, in linear light
const SUN_COLOR: vec3<f32> = vec3<f32>(1.0, 0.9047, 0.6724) * 2.0;     // 0xfff4d6 x 2.0
const HEMI_SKY: vec3<f32> = vec3<f32>(0.7379, 0.8963, 1.0) * 1.5;      // 0xdff3ff x 1.5
// render/skyEnvironment.ts: the reflection map's ground (0x9a8f78), and its sun disc
const ENV_GROUND: vec3<f32> = vec3<f32>(0.3231, 0.2747, 0.1878);
const SUN_GLINT: vec3<f32> = vec3<f32>(1.0, 0.92, 0.75) * 2.5;
const HEMI_GROUND: vec3<f32> = vec3<f32>(0.2747, 0.2541, 0.1878) * 1.5; // 0x8f8a78 x 1.5

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) nrm: vec3<f32>,
    @location(1) col: vec3<f32>,
    @location(2) depth: f32,
    @location(3) uv: vec2<f32>,
    @location(4) @interpolate(flat) layer: i32,
    @location(5) world: vec3<f32>,
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let k = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    return select(1.055 * pow(k, vec3<f32>(1.0 / 2.4)) - 0.055, k * 12.92, k <= vec3<f32>(0.0031308));
}

// three's NeutralToneMapping (Khronos PBR Neutral), exposure included
fn neutral(color_in: vec3<f32>) -> vec3<f32> {
    let start = 0.8 - 0.04;
    let desaturation = 0.15;
    var color = color_in * EXPOSURE;
    let x = min(color.r, min(color.g, color.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    color -= offset;
    let peak = max(color.r, max(color.g, color.b));
    if (peak < start) {
        return color;
    }
    let d = 1.0 - start;
    let new_peak = 1.0 - d * d / (peak + d - start);
    color *= new_peak / peak;
    let g = 1.0 - 1.0 / (desaturation * (peak - new_peak) + 1.0);
    return mix(color, vec3<f32>(new_peak), g);
}

// The sun's shadow at a world point (renderer.ts: a 2048/1024 map over a 44 m box, bias -0.0004,
// PCF soft): 3 x 3 hardware-filtered comparisons. Outside the box, or with shadows off: lit.
fn sun_shadow(world: vec3<f32>) -> f32 {
    let c = u.light * vec4<f32>(world, 1.0);
    let p = c.xyz / c.w;
    let uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    let inside = u.shadow.z > 0.5 && all(uv > vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0)) && p.z < 1.0;
    let depth = p.z - u.shadow.y;
    var lit = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            lit += textureSampleCompareLevel(shadow_map, shadow_sampler, uv + vec2<f32>(f32(x), f32(y)) * u.shadow.x, depth);
        }
    }
    return select(1.0, lit / 9.0, inside);
}

fn f_schlick(f0: vec3<f32>, f90: f32, dot_vh: f32) -> vec3<f32> {
    let fresnel = exp2((-5.55473 * dot_vh - 6.98316) * dot_vh);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

fn v_ggx_smith_correlated(alpha: f32, dot_nl: f32, dot_nv: f32) -> f32 {
    let a2 = alpha * alpha;
    let gv = dot_nl * sqrt(a2 + (1.0 - a2) * dot_nv * dot_nv);
    let gl = dot_nv * sqrt(a2 + (1.0 - a2) * dot_nl * dot_nl);
    return 0.5 / max(gv + gl, 1e-6);
}

fn d_ggx(alpha: f32, dot_nh: f32) -> f32 {
    let a2 = alpha * alpha;
    let denom = dot_nh * dot_nh * (a2 - 1.0) + 1.0;
    return RECIPROCAL_PI * a2 / (denom * denom);
}

fn brdf_ggx(l: vec3<f32>, v: vec3<f32>, n: vec3<f32>, f0: vec3<f32>, f90: f32, roughness: f32) -> vec3<f32> {
    let alpha = roughness * roughness;
    let h = normalize(l + v);
    let dot_nl = clamp(dot(n, l), 0.0, 1.0);
    let dot_nv = clamp(dot(n, v), 0.0, 1.0);
    let dot_nh = clamp(dot(n, h), 0.0, 1.0);
    let dot_vh = clamp(dot(v, h), 0.0, 1.0);
    return f_schlick(f0, f90, dot_vh) * (v_ggx_smith_correlated(alpha, dot_nl, dot_nv) * d_ggx(alpha, dot_nh));
}

// The reflection map (skyEnvironment.ts): the sky gradient above, a warm grey ground below, a
// soft sun disc. three blurs it per roughness (PMREM); here the sharp gradient eases toward the
// irradiance as the surface roughens, and the sun disc widens.
fn env_sharp(d: vec3<f32>) -> vec3<f32> {
    let sky = mix(u.horizon.rgb, u.top.rgb, smoothstep(0.0, 0.5, d.y));
    let below = mix(u.horizon.rgb, ENV_GROUND, smoothstep(0.0, -0.18, d.y));
    return select(below, sky, d.y >= 0.0);
}

fn env_irradiance(n: vec3<f32>) -> vec3<f32> {
    let sky = mix(u.horizon.rgb, u.top.rgb, 0.6);
    let below = mix(u.horizon.rgb, ENV_GROUND, 0.7);
    return mix(below, sky, 0.5 * n.y + 0.5);
}

fn env_radiance(d: vec3<f32>, roughness: f32) -> vec3<f32> {
    let r2 = roughness * roughness;
    let exponent = max(64.0 * (1.0 - roughness) * (1.0 - roughness), 2.0);
    let glint = SUN_GLINT * pow(max(dot(d, normalize(u.sun.xyz)), 0.0), exponent) * (exponent / 64.0);
    return mix(env_sharp(d), env_irradiance(d), r2) + glint;
}

// three's DFGApprox (Karis): the split-sum scale and bias for image-based specular
fn dfg_approx(dot_nv: f32, roughness: f32) -> vec2<f32> {
    let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
    let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
    let r = roughness * c0 + c1;
    let a004 = min(r.x * r.x, exp2(-9.28 * dot_nv)) * r.x + r.y;
    return vec2<f32>(-1.04, 1.04) * a004 + r.zw;
}

@vertex
fn vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec4<f32>, @location(2) look: vec4<f32>, @location(3) uv: vec2<f32>) -> VsOut {
    var o: VsOut;
    o.clip = u.view_proj * vec4<f32>(pos, 1.0);
    o.nrm = nrm.xyz;
    o.col = srgb_to_linear(look.rgb);
    o.depth = o.clip.w;
    o.uv = uv;
    o.layer = i32(look.a * 255.0 + 0.5);
    o.world = pos;
    return o;
}

// Studs: the Blender stud meshes (studs.rs) instanced on every open brick top (voxelView.ts
// rebuildStuds). Each top is drawn by exactly one form, picked by its distance to the focus: the
// original Stud_HQ out to studs.x, Stud_LOD1 out to studs.y. A top outside a form's band
// collapses to a point outside the view (the web's per-cell `withinRange`). Texture coordinates
// are world-planar (the brick's top tile).
fn stud(pos: vec3<f32>, nrm: vec4<f32>, at: vec3<f32>, look: vec4<f32>, lo: f32, hi: f32) -> VsOut {
    var o: VsOut;
    let world = at + pos;
    let d = distance(at, u.focus.xyz);
    if (d <= lo || d > hi) {
        o.clip = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    } else {
        o.clip = u.view_proj * vec4<f32>(world, 1.0);
    }
    o.nrm = nrm.xyz;
    o.col = srgb_to_linear(look.rgb);
    o.depth = o.clip.w;
    o.uv = vec2<f32>(world.x, -world.z);
    o.layer = i32(look.a * 255.0 + 0.5);
    o.world = world;
    return o;
}

@vertex
fn stud_hq_vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec4<f32>, @location(4) at: vec3<f32>, @location(5) look: vec4<f32>) -> VsOut {
    return stud(pos, nrm, at, look, -1.0, u.studs.x);
}

@vertex
fn stud_lod_vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec4<f32>, @location(4) at: vec3<f32>, @location(5) look: vec4<f32>) -> VsOut {
    return stud(pos, nrm, at, look, u.studs.x, u.studs.y);
}

@fragment
fn fs(i: VsOut) -> @location(0) vec4<f32> {
    let layer = clamp(i.layer, 0, 127);
    let m0 = materials[layer * 3];
    let m1 = materials[layer * 3 + 1];
    let m2 = materials[layer * 3 + 2];
    // every sample up front: derivatives need uniform control flow
    let picture = textureSample(surfaces, surface_sampler, i.uv, i.layer).rgb;
    let map_n = textureSample(normal_maps, surface_sampler, i.uv, i.layer).xyz * 2.0 - 1.0;
    let orm = textureSample(orm_maps, surface_sampler, i.uv, i.layer);
    let q0 = dpdx(i.world);
    let q1 = dpdy(i.world);
    let st0 = dpdx(i.uv);
    let st1 = dpdy(i.uv);
    let geometry_normal = normalize(i.nrm);
    let dxy = max(abs(dpdx(geometry_normal)), abs(dpdy(geometry_normal)));

    // three's perturbNormal2Arb: the normal map in a screen-space cotangent frame
    let q1perp = cross(q1, geometry_normal);
    let q0perp = cross(geometry_normal, q0);
    let t = q1perp * st0.x + q0perp * st1.x;
    let b = q1perp * st0.y + q0perp * st1.y;
    let det = max(dot(t, t), dot(b, b));
    let scale = select(inverseSqrt(det), 0.0, det == 0.0);
    let mn = vec3<f32>(map_n.xy * m0.z, map_n.z);
    let n = normalize(t * (mn.x * scale) + b * (mn.y * scale) + geometry_normal * mn.z);

    let albedo = picture * i.col;
    let metalness = m0.y * orm.b;
    let geometry_roughness = max(max(dxy.x, dxy.y), dxy.z);
    let roughness = min(max(m0.x * orm.g, 0.0525) + geometry_roughness, 1.0);
    let diffuse = albedo * (1.0 - metalness);
    let f0 = mix(vec3<f32>(0.04), albedo, metalness);

    let v = normalize(u.eye.xyz - i.world);
    let l = normalize(u.sun.xyz);
    // the sun: Lambert + GGX
    let shade = sun_shadow(i.world);
    let irradiance = clamp(dot(n, l), 0.0, 1.0) * SUN_COLOR * shade;
    var light = irradiance * diffuse * RECIPROCAL_PI + irradiance * brdf_ggx(l, v, n, f0, 1.0, roughness);
    // the hemisphere fill (indirect diffuse only, as three without an environment map)
    let hemi = mix(HEMI_GROUND, HEMI_SKY, 0.5 * n.y + 0.5);
    light += hemi * diffuse * RECIPROCAL_PI;
    // the sky reflection (metal 1.15, gem 0.8, glass 0.7, ore 0.25: voxelView setEnvironment),
    // three's RE_IndirectSpecular_Physical with multiple scattering
    let env = m2.y;
    if (env > 0.0) {
        let dot_nv = clamp(dot(n, v), 0.0, 1.0);
        let radiance = env_radiance(reflect(-v, n), roughness) * env;
        let irr = env_irradiance(n) * env;
        let fab = dfg_approx(dot_nv, roughness);
        let fss_ess = f0 * fab.x + fab.y;
        let ess = fab.x + fab.y;
        let ems = 1.0 - ess;
        let favg = f0 + (1.0 - f0) * 0.047619;
        let fms = fss_ess * favg / (1.0 - ems * favg);
        let multi = fms * ems;
        let total = fss_ess + multi;
        light += radiance * fss_ess + multi * irr + diffuse * (1.0 - max(max(total.r, total.g), total.b)) * irr;
    }
    // the clearcoat: a second, smoother specular lobe on the geometry normal
    let clearcoat = m0.w;
    if (clearcoat > 0.0) {
        let cc_irradiance = clamp(dot(geometry_normal, l), 0.0, 1.0) * SUN_COLOR * shade;
        let cc_roughness = min(max(m2.x, 0.0525) + geometry_roughness, 1.0);
        let fcc = f_schlick(vec3<f32>(0.04), 1.0, clamp(dot(geometry_normal, v), 0.0, 1.0));
        light = light * (1.0 - clearcoat * fcc) + cc_irradiance * brdf_ggx(l, v, geometry_normal, vec3<f32>(0.04), 1.0, cc_roughness) * clearcoat;
    }
    // glow: glowstone lit by its own picture, gems a faint constant teal
    light += m1.rgb * select(vec3<f32>(1.0), picture, m1.w > 0.5);

    // tone map, to sRGB, then the fog in sRGB with a smoothstep (three's order)
    let toned = linear_to_srgb(neutral(light));
    let fog = smoothstep(u.fog.x, u.fog.y, i.depth);
    let shown = mix(toned, linear_to_srgb(u.horizon.rgb), fog);
    // alpha only matters in the blended (see-through) pipeline; the opaque one does not blend
    return vec4<f32>(srgb_to_linear(shown), u.fog.z);
}

struct SkyOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) ndc: vec2<f32>,
}

@vertex
fn sky_vs(@builtin(vertex_index) i: u32) -> SkyOut {
    // one triangle covering the screen
    let xy = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
    var o: SkyOut;
    o.clip = vec4<f32>(xy, 0.0, 1.0);
    o.ndc = xy;
    return o;
}

@fragment
fn sky_fs(i: SkyOut) -> @location(0) vec4<f32> {
    let far = u.inv_view_proj * vec4<f32>(i.ndc, 1.0, 1.0);
    let dir = normalize(far.xyz / far.w - u.eye.xyz);
    let t = smoothstep(0.0, 0.45, dir.y);
    // the SkyDome shader tone maps its gradient like everything else
    return vec4<f32>(srgb_to_linear(linear_to_srgb(neutral(mix(u.horizon.rgb, u.top.rgb, t)))), 1.0);
}

// ---- the characters (character.rs): the web's HOME / TT models, CPU-skinned in world space.
// homeRig.ts gives them a MeshStandardMaterial: roughness 0.9, metalness 0, their painted face
// texture as the map AND as an emissive map at 0.18 (a toy keeps its true colour on the shaded
// side). Lit by the same sun and hemisphere, tone mapped and fogged exactly like the terrain.
@group(1) @binding(0) var char_texture: texture_2d<f32>;
@group(1) @binding(1) var char_sampler: sampler;

struct CharOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) nrm: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) world: vec3<f32>,
    @location(3) depth: f32,
}

@vertex
fn char_vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) uv: vec2<f32>) -> CharOut {
    var o: CharOut;
    o.clip = u.view_proj * vec4<f32>(pos, 1.0);
    o.nrm = nrm;
    o.uv = uv;
    o.world = pos;
    o.depth = o.clip.w;
    return o;
}

@fragment
fn char_fs(i: CharOut) -> @location(0) vec4<f32> {
    let albedo = textureSample(char_texture, char_sampler, i.uv).rgb;
    let n = normalize(i.nrm);
    let v = normalize(u.eye.xyz - i.world);
    let l = normalize(u.sun.xyz);
    let roughness = 0.9;
    let f0 = vec3<f32>(0.04);
    let irradiance = clamp(dot(n, l), 0.0, 1.0) * SUN_COLOR * sun_shadow(i.world);
    var light = irradiance * albedo * RECIPROCAL_PI + irradiance * brdf_ggx(l, v, n, f0, 1.0, roughness);
    let hemi = mix(HEMI_GROUND, HEMI_SKY, 0.5 * n.y + 0.5);
    light += hemi * albedo * RECIPROCAL_PI;
    light += albedo * 0.18;
    let toned = linear_to_srgb(neutral(light));
    let fog = smoothstep(u.fog.x, u.fog.y, i.depth);
    let shown = mix(toned, linear_to_srgb(u.horizon.rgb), fog);
    return vec4<f32>(srgb_to_linear(shown), 1.0);
}

// ---- the shadow pass: depth from the sun (fragment-less pipelines)
@vertex
fn shadow_vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
    return u.light * vec4<f32>(pos, 1.0);
}

@vertex
fn char_shadow_vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
    return u.light * vec4<f32>(pos, 1.0);
}

// ---- furniture (furniture.rs): the web's FurnitureView material, MeshStandardMaterial with vertex
// colours, roughness 0.68, metalness 0.02 (as a dielectric), lit and fogged like everything else.
struct FurnOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) nrm: vec3<f32>,
    @location(1) col: vec3<f32>,
    @location(2) world: vec3<f32>,
    @location(3) depth: f32,
    @location(4) alpha: f32,
}

@vertex
fn furn_vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) col: vec4<f32>) -> FurnOut {
    var o: FurnOut;
    o.clip = u.view_proj * vec4<f32>(pos, 1.0);
    o.nrm = nrm;
    o.col = srgb_to_linear(col.rgb);
    o.alpha = col.a;
    o.world = pos;
    o.depth = o.clip.w;
    return o;
}

@fragment
fn furn_fs(i: FurnOut) -> @location(0) vec4<f32> {
    // a part seen from inside (an open tub) faces away: light it as its other side
    let n0 = normalize(i.nrm);
    let v = normalize(u.eye.xyz - i.world);
    let n = select(n0, -n0, dot(n0, v) < 0.0);
    let l = normalize(u.sun.xyz);
    let albedo = i.col;
    let irradiance = clamp(dot(n, l), 0.0, 1.0) * SUN_COLOR * sun_shadow(i.world);
    var light = irradiance * albedo * RECIPROCAL_PI + irradiance * brdf_ggx(l, v, n, vec3<f32>(0.04), 1.0, 0.68);
    let hemi = mix(HEMI_GROUND, HEMI_SKY, 0.5 * n.y + 0.5);
    light += hemi * albedo * RECIPROCAL_PI;
    let toned = linear_to_srgb(neutral(light));
    let fog = smoothstep(u.fog.x, u.fog.y, i.depth);
    let shown = mix(toned, linear_to_srgb(u.horizon.rgb), fog);
    return vec4<f32>(srgb_to_linear(shown), i.alpha);
}

@fragment
fn fire_fx_fs(i: FurnOut) -> @location(0) vec4<f32> {
    let circle=clamp(1.0-4.0*dot(i.nrm.xy,i.nrm.xy),0.0,1.0);
    return vec4<f32>(i.col,i.alpha*smoothstep(0.0,0.65,circle));
}

// ---- water (water.rs): waterMesh.ts's material ported line for line — MeshStandardMaterial
// 0x389fbe, roughness 0.19, double-sided, blended; the advected detail texture, waterfall
// curtains, impact ripples, depth absorption toward uDeep, a Fresnel sky reflection, foam and
// shore bubbles. Not ported: the 180 ms vertex transition between rebuilds (aTransition).
// group(1) holds the detail texture (Rgba8Unorm, repeating) in the character layout's slots.
struct WaterOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) nrm: vec3<f32>,
    @location(2) flow: vec3<f32>,
    @location(3) water: vec3<f32>, // wet, foam, depth
    @location(4) impact: vec3<f32>,
    @location(5) depth: f32,
}

fn swell(p: vec2<f32>, t: f32) -> f32 {
    return 0.018 * sin(dot(p, vec2<f32>(0.58904862, 0.39269908)) + t * 0.9)
         + 0.011 * sin(dot(p, vec2<f32>(-0.39269908, 0.98174770)) + t * 1.3);
}

@vertex
fn water_vs(@location(0) pos: vec3<f32>, @location(1) nrm: vec3<f32>, @location(2) look: vec4<f32>, @location(3) flow: vec3<f32>, @location(4) impact: vec3<f32>) -> WaterOut {
    var o: WaterOut;
    var p = pos;
    // no face-normal displacement: it would split a waterfall's edges
    p.y += look.x * swell(pos.xz + u.water.yz, u.water.x);
    o.clip = u.view_proj * vec4<f32>(p, 1.0);
    o.world = p;
    o.nrm = nrm;
    o.flow = flow;
    o.water = look.yzw;
    o.impact = impact;
    o.depth = o.clip.w;
    return o;
}

// overlapping phases advect the pattern without a periodic reset
fn water_noise(p: vec2<f32>, drift: vec2<f32>) -> vec4<f32> {
    let phase = fract(u.water.x * 0.05);
    let other = fract(u.water.x * 0.05 + 0.5);
    let weight = 1.0 - abs(2.0 * phase - 1.0);
    return mix(textureSample(char_texture, char_sampler, p - drift * other), textureSample(char_texture, char_sampler, p - drift * phase), weight);
}

@fragment
fn water_fs(i: WaterOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    let t = u.water.x;
    let p = i.world.xz + u.water.yz;
    let curtain = i.flow.y > 0.5 && abs(i.nrm.y) < 0.5;
    let drift = vec2<f32>(0.09, 0.035) + i.flow.xz * 0.55;
    // every sample up front (uniform control flow), the branch picks
    let along = dot(p, vec2<f32>(-i.nrm.z, i.nrm.x));
    let d_curtain = water_noise(vec2<f32>(along * 0.5, i.world.y * 0.0625), vec2<f32>(0.025, -1.2));
    let d_flat = water_noise(p * 0.0625, drift);
    let fine = textureSample(char_texture, char_sampler, p * 0.125 + vec2<f32>(-t * 0.004, t * 0.003)).rg;
    var detail: vec4<f32>;
    var wn = normalize(i.nrm);
    if (curtain) {
        detail = d_curtain;
        wn = normalize(wn + vec3<f32>(detail.r - 0.5, 0.0, detail.g - 0.5) * 0.14);
    } else {
        detail = d_flat;
        var slope = (detail.rg - 0.5) * 0.3 + (fine - 0.5) * 0.13;
        if (i.impact.z > 0.001) {
            let delta = p - (i.impact.xy / i.impact.z + u.water.yz);
            let distance = length(delta);
            slope += delta / max(0.05, distance) * cos(distance * 10.0 - t * 5.0) * exp(-distance * 0.9) * i.impact.z * 0.16;
        }
        let calm = mix(0.4, 1.0, smoothstep(0.08, 0.8, i.water.z));
        wn = normalize(wn + vec3<f32>(-slope.x, 0.0, -slope.y) * calm);
    }
    if (!front) {
        wn = -wn;
    }
    // the standard material's light
    let albedo = srgb_to_linear(vec3<f32>(0.2196, 0.6235, 0.7451)); // 0x389fbe
    let v = normalize(u.eye.xyz - i.world);
    let l = normalize(u.sun.xyz);
    let irradiance = clamp(dot(wn, l), 0.0, 1.0) * SUN_COLOR * sun_shadow(i.world);
    var light = irradiance * albedo * RECIPROCAL_PI + irradiance * brdf_ggx(l, v, wn, vec3<f32>(0.04), 1.0, 0.19);
    light += mix(HEMI_GROUND, HEMI_SKY, 0.5 * wn.y + 0.5) * albedo * RECIPROCAL_PI;
    // waterMesh.ts's opaque_fragment
    let facing = clamp(abs(dot(wn, v)), 0.0, 1.0);
    let f = 1.0 - facing;
    let fresnel = 0.0204 + 0.9796 * f * f * f * f * f;
    let optical = min(18.0, i.water.z / max(0.28, facing));
    let absorb = 1.0 - exp(-optical * 0.22);
    light = mix(light, srgb_to_linear(vec3<f32>(0.0706, 0.4235, 0.5137)), absorb * 0.68); // uDeep 0x126c83
    let sky = srgb_to_linear(vec3<f32>(0.7255, 0.8941, 0.949)); // uSky 0xb9e4f2
    let reflected = mix(sky, vec3<f32>(0.27, 0.54, 0.68), clamp(reflect(-v, wn).y, 0.0, 1.0) * 0.38);
    light = mix(light, reflected, fresnel * 0.85);
    var alpha = clamp(0.32 + absorb * 0.48 + fresnel * 0.42, 0.32, 0.94);
    let impact = i.water.y * smoothstep(0.4, 0.68, detail.b) * 0.76;
    let shore = (1.0 - i.water.x) * smoothstep(0.48, 0.72, detail.a) * 0.26;
    var bubbles = max(impact, shore);
    if (curtain) {
        let threads = smoothstep(0.37, 0.7, detail.a);
        light = mix(light, vec3<f32>(0.3, 0.64, 0.72), 0.42);
        bubbles = threads * 0.26;
        alpha = 0.3 + threads * 0.16 + fresnel * 0.12;
    } else {
        // a narrow trickle or a lone source must stay visible too
        alpha *= mix(0.68, 1.0, smoothstep(0.1, 0.95, i.water.x));
    }
    light = mix(light, vec3<f32>(0.86, 0.94, 0.95), bubbles);
    alpha = max(alpha, bubbles * 0.85);
    let toned = linear_to_srgb(neutral(light));
    let fog = smoothstep(u.fog.x, u.fog.y, i.depth);
    let shown = mix(toned, linear_to_srgb(u.horizon.rgb), fog);
    return vec4<f32>(srgb_to_linear(shown), alpha);
}

// The placement ghost (craftGame.ts ghostOk / ghostBad): the piece's own shape in a flat tint —
// the vertex colour carries it (green fits, red does not) — lit softly so its form reads, half
// see-through, fogged like the world.
@fragment
fn fs_ghost(i: VsOut) -> @location(0) vec4<f32> {
    let n = normalize(i.nrm);
    let shade = 0.62 + 0.38 * max(dot(n, normalize(u.sun.xyz)), 0.0) + 0.12 * max(n.y, 0.0);
    let c = srgb_to_linear(i.col) * shade;
    return vec4<f32>(c, 0.42);
}
