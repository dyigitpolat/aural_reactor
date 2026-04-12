// Vignette + exposure — baseline cinematic framing.
uniform float uIntensity;
uniform float uExposure;

vec4 apply(vec2 uv, float time) {
    vec4 c = texture(uSrc, uv);
    vec2 d = uv - 0.5;
    float r2 = dot(d, d);
    float v = smoothstep(0.75, 0.15, r2);
    v = mix(1.0, v, clamp(uIntensity, 0.0, 1.0));
    vec3 outc = c.rgb * v * (1.0 + uExposure);
    return vec4(clamp(outc, 0.0, 1.0), c.a);
}
