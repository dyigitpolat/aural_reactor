// Film grain — animated monochromatic noise overlay.
uniform float uIntensity;
uniform float uSize;

vec4 apply(vec2 uv, float time) {
    vec4 c = texture(uSrc, uv);
    float g = hash12(uv * max(200.0, uSize * 600.0) + time * 60.0);
    float n = (g - 0.5) * (0.35 * uIntensity);
    return vec4(clamp(c.rgb + n, 0.0, 1.0), c.a);
}
