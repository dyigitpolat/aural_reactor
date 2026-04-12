// Chromatic aberration / RGB split — channels offset radially from center.
uniform float uIntensity;
uniform float uAngle;

vec4 apply(vec2 uv, float time) {
    vec2 dir = vec2(cos(uAngle), sin(uAngle));
    vec2 radial = normalize(uv - 0.5 + 1e-5) * 0.5 + dir * 0.5;
    float amt = 0.015 * uIntensity;
    float r = texture(uSrc, uv + radial * amt).r;
    float g = texture(uSrc, uv).g;
    float b = texture(uSrc, uv - radial * amt).b;
    float a = texture(uSrc, uv).a;
    return vec4(r, g, b, a);
}
