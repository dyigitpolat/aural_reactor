// Camera shake — random 2D offset with time-varying seed.
uniform float uIntensity;
uniform float uFreq;

vec4 apply(vec2 uv, float time) {
    float t = time * max(1.0, uFreq);
    float dx = (hash11(floor(t * 12.0) + 3.1) - 0.5) * 2.0;
    float dy = (hash11(floor(t * 12.0) + 7.7) - 0.5) * 2.0;
    vec2 offset = vec2(dx, dy) * (0.04 * uIntensity);
    vec2 q = clamp(uv + offset, vec2(0.0), vec2(1.0));
    return texture(uSrc, q);
}
