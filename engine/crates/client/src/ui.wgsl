// The screen overlay: shapes as signed distance fields, so every edge is crisp and anti-aliased
// at any size and density (no textures). Each shape is a quad; `local` is the pixel offset from
// the shape's anchor, `shape` = (kind, a, b, c):
//   kind 0: disc of radius a                     kind 1: ring of radius a, line width b
//   kind 2: capsule from the anchor to (a, b), half width c  (an arrow stroke, a cross arm)
//   kind 3: rounded rectangle, half size (a, b), corner radius c  (panels, buttons, fields)
//   kind 4: a glyph: `local` is the texel in the text atlas (text.rs) and coverage is read from
//           it, one drawn pixel per texel, so text is as sharp as the platform's own
//   kind 5: a picture (art.rs): `local` is its uv (0..1); drawn tinted by the colour

@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var picture: texture_2d<f32>;
@group(0) @binding(2) var picture_sampler: sampler;

struct VsIn {
    @location(0) ndc: vec2<f32>,
    @location(1) local: vec2<f32>,
    @location(2) shape: vec4<f32>,
    @location(3) color: vec4<f32>,
}

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) local: vec2<f32>,
    @location(1) @interpolate(flat) shape: vec4<f32>,
    @location(2) color: vec4<f32>,
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    return select(1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3<f32>(0.0031308));
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

@vertex
fn vs(i: VsIn) -> VsOut {
    var o: VsOut;
    o.clip = vec4<f32>(i.ndc, 0.0, 1.0);
    o.local = i.local;
    o.shape = i.shape;
    // colours are picked in sRGB like the web's CSS; the surface is sRGB
    o.color = vec4<f32>(srgb_to_linear(i.color.rgb), i.color.a);
    return o;
}

// Two ways to draw the same overlay: on an sRGB view (colours turned linear, blended in linear
// light) or, where the platform allows, on a non-sRGB view of the same image (colours and pictures
// kept as sRGB values, blended like a browser blends CSS) — see gpu.rs ui_format.
fn shade(i: VsOut, gamma: bool) -> vec4<f32> {
    // sampled before any branch: filtered sampling needs uniform control flow (the result is only
    // used by pictures; other shapes sample the bound 1×1 white or an unrelated texel and ignore it)
    let sampled = textureSample(picture, picture_sampler, i.local);
    // pictures are sRGB textures (sampling returns linear): back to sRGB values on the gamma path
    let art = select(sampled, vec4<f32>(linear_to_srgb(sampled.rgb), sampled.a), gamma);
    var d: f32;
    let kind = i.shape.x;
    if (kind > 4.5) {
        let c = art * i.color;
        if (c.a <= 0.0) {
            discard;
        }
        return c;
    }
    if (kind > 3.5) {
        let cover = textureLoad(atlas, vec2<i32>(floor(i.local)), 0).r;
        if (cover <= 0.0) {
            discard;
        }
        return vec4<f32>(i.color.rgb, i.color.a * cover);
    }
    if (kind > 2.5) {
        let r = min(i.shape.w, min(i.shape.y, i.shape.z));
        let q = abs(i.local) - i.shape.yz + vec2<f32>(r);
        d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
    } else if (kind < 0.5) {
        d = length(i.local) - i.shape.y;
    } else if (kind < 1.5) {
        d = abs(length(i.local) - i.shape.y) - i.shape.z * 0.5;
    } else {
        let b = i.shape.yz;
        let t = clamp(dot(i.local, b) / max(dot(b, b), 1e-6), 0.0, 1.0);
        d = length(i.local - b * t) - i.shape.w;
    }
    // one pixel of anti-aliasing
    let cover = clamp(0.5 - d, 0.0, 1.0);
    if (cover <= 0.0) {
        discard;
    }
    return vec4<f32>(i.color.rgb, i.color.a * cover);
}

@vertex
fn vs_gamma(i: VsIn) -> VsOut {
    var o: VsOut;
    o.clip = vec4<f32>(i.ndc, 0.0, 1.0);
    o.local = i.local;
    o.shape = i.shape;
    o.color = i.color;
    return o;
}

@fragment
fn fs(i: VsOut) -> @location(0) vec4<f32> {
    return shade(i, false);
}

@fragment
fn fs_gamma(i: VsOut) -> @location(0) vec4<f32> {
    return shade(i, true);
}
