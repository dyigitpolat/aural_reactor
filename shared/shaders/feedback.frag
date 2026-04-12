// Feedback / echo trail — previous-frame texture blended with current.
// The preview and render pipelines bind uPrev to the previous output FBO.
uniform sampler2D uPrev;
uniform float uIntensity;
uniform float uZoom;

vec4 apply(vec2 uv, float time) {
    vec4 cur = texture(uSrc, uv);
    // Slight zoom on the previous frame to create the trailing plume
    vec2 q = (uv - 0.5) * (1.0 - 0.02 * uZoom) + 0.5;
    vec4 prev = texture(uPrev, q);
    vec3 mixed = max(cur.rgb, prev.rgb * (0.85 + 0.12 * uIntensity));
    return vec4(mix(cur.rgb, mixed, uIntensity), cur.a);
}
