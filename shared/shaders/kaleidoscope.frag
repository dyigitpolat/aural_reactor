// Kaleidoscope — N-fold radial symmetry with rotation.
uniform float uIntensity;
uniform float uSegments;
uniform float uRotation;

vec4 apply(vec2 uv, float time) {
    vec2 p = uv - 0.5;
    float r = length(p);
    float a = atan(p.y, p.x);

    float seg = max(2.0, floor(uSegments));
    float slice = 6.2831853 / seg;
    a = mod(a + uRotation, slice);
    a = abs(a - slice * 0.5);

    vec2 q = vec2(cos(a), sin(a)) * r + 0.5;
    q = clamp(q, vec2(0.0), vec2(1.0));
    vec4 kale = texture(uSrc, q);
    vec4 base = texture(uSrc, uv);
    return mix(base, kale, clamp(uIntensity, 0.0, 1.0));
}
