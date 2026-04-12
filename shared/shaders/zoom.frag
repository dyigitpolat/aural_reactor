// Zoom punch — scale toward center, intensity drives amount.
uniform float uIntensity;
uniform float uCenterX;
uniform float uCenterY;

vec4 apply(vec2 uv, float time) {
    vec2 center = vec2(uCenterX, uCenterY);
    float k = 1.0 - 0.35 * uIntensity;
    vec2 z = (uv - center) * k + center;
    z = clamp(z, vec2(0.0), vec2(1.0));
    return texture(uSrc, z);
}
