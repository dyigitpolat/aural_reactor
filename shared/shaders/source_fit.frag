// Mandatory prelude pass — center-crop-to-fit.
//
// Takes the raw source frame (any aspect ratio) and produces a texture at the
// output aspect ratio, with the clip scaled uniformly and the long axis
// cropped. Not part of the user's effect chain; runs before anything else in
// both the browser preview and the Python render pipeline so every downstream
// effect operates on correctly-proportioned pixels.

uniform float uClipAspect;    // clipWidth / clipHeight
uniform float uOutputAspect;  // outputWidth / outputHeight

vec4 apply(vec2 uv, float time) {
    vec2 scale;
    if (uClipAspect > uOutputAspect) {
        // Clip is wider than output — crop left/right, keep full height.
        scale = vec2(uOutputAspect / uClipAspect, 1.0);
    } else {
        // Clip is taller than (or equal to) output — crop top/bottom.
        scale = vec2(1.0, uClipAspect / uOutputAspect);
    }
    vec2 src = (uv - 0.5) * scale + 0.5;
    return texture(uSrc, clamp(src, vec2(0.0), vec2(1.0)));
}
