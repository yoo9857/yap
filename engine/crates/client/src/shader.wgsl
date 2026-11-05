// The terrain: the block surface times its tint, lit by one sun plus a sky/ground hemisphere
// fill, fogged linearly toward the horizon colour (craftGame.ts's THREE.Fog). The sky: the
// web's SkyDome gradient, horizon colour at and below eye level easing to blue overhead.

struct Uniforms {
    view_proj: mat4x4<f32>,
    inv_view_proj: mat4x4<f32>,
    eye: vec4<f32>,
    sun: vec4<f32>,      // xyz: direction toward the sun
    horizon: vec4<f32>,  // fog colour = the sky at the horizon
    top: vec4<f32>,      // the sky overhead
    fog: vec4<f32>,      // x: start, y: end (view depth, metres), z: see-through opacity
    focus: vec4<f32>,    // xyz: the LOD/stud focus
    studs: vec4<f32>,    // x: Stud_HQ out to here, y: Stud_LOD1 out to here (metres)
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var surface_sampler: sampler;

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) nrm: vec3<f32>,
    @location(1) col: vec3<f32>,
    @location(2) depth: f32,
    @location(3) uv: vec2<f32>,
    @location(4) @interpolate(flat) layer: i32,
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
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
    let n = normalize(i.nrm);
    let sun = max(dot(n, normalize(u.sun.xyz)), 0.0) * 0.75;
    let hemi = mix(0.42, 0.62, n.y * 0.5 + 0.5);
    let surface = textureSample(surfaces, surface_sampler, i.uv, i.layer).rgb;
    let lit = surface * i.col * (sun + hemi);
    // linear, like THREE.Fog
    let fog = clamp((i.depth - u.fog.x) / (u.fog.y - u.fog.x), 0.0, 1.0);
    // alpha only matters in the blended (see-through) pipeline; the opaque one does not blend
    return vec4<f32>(mix(lit, u.horizon.rgb, fog), u.fog.z);
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
    return vec4<f32>(mix(u.horizon.rgb, u.top.rgb, t), 1.0);
}
