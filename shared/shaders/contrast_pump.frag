// Contrast pump — side-chain-style pump around mid grey, driven by intensity.
uniform float uIntensity;
uniform float uSaturation;

vec4 apply(vec2 uv, float time) {
    vec4 c = texture(uSrc, uv);
    float contrast = 1.0 + uIntensity * 0.9;
    vec3 pumped = (c.rgb - 0.5) * contrast + 0.5;
    float grey = luma(pumped);
    float sat = 1.0 + uSaturation * uIntensity;
    vec3 outc = mix(vec3(grey), pumped, sat);
    return vec4(clamp(outc, 0.0, 1.0), c.a);
}
