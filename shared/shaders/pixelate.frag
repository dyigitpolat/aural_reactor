// Pixelate / mosaic with variable tile size.
uniform float uIntensity;
uniform float uAspect;

vec4 apply(vec2 uv, float time) {
    float size = mix(1.0, 100.0, clamp(uIntensity, 0.0, 1.0));
    vec2 cells = vec2(size * uAspect, size);
    vec2 q = (floor(uv * cells) + 0.5) / cells;
    return texture(uSrc, q);
}
