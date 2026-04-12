// Light leak — warm radial gradient screen-blended onto the image.
uniform float uIntensity;
uniform float uHue;

vec4 apply(vec2 uv, float time) {
    vec4 base = texture(uSrc, uv);
    float angle = uHue + time * 0.15;
    vec2 center = 0.5 + 0.35 * vec2(cos(angle), sin(angle * 0.7));
    float d = distance(uv, center);
    float glow = smoothstep(0.55, 0.0, d);
    vec3 warm = hsv2rgb(vec3(fract(uHue + 0.06), 0.5, 1.0));
    vec3 leak = warm * glow * (1.2 * uIntensity);
    vec3 c = 1.0 - (1.0 - base.rgb) * (1.0 - leak);
    return vec4(c, base.a);
}
