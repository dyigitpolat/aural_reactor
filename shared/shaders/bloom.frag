// Cheap single-pass bloom — threshold + box blur approximation + add.
uniform float uIntensity;
uniform float uThreshold;

vec4 apply(vec2 uv, float time) {
    vec4 base = texture(uSrc, uv);
    vec3 sum = vec3(0.0);
    float w = 0.0;
    for (int i = -2; i <= 2; i++) {
        for (int j = -2; j <= 2; j++) {
            vec2 off = vec2(float(i), float(j)) * 0.008;
            vec3 s = texture(uSrc, uv + off).rgb;
            float lum = luma(s);
            float k = smoothstep(uThreshold, 1.0, lum);
            sum += s * k;
            w += 1.0;
        }
    }
    vec3 bloom = sum / w;
    return vec4(base.rgb + bloom * (2.0 * uIntensity), base.a);
}
