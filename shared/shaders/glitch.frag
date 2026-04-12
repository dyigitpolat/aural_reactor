// Glitch block displacement — horizontal slices shifted randomly, occasional channel swap.
uniform float uIntensity;
uniform float uSeed;

vec4 apply(vec2 uv, float time) {
    float slice = floor(uv.y * 40.0);
    float rand = hash11(slice + floor(time * 12.0) + uSeed);
    float doShift = step(0.7, rand);
    float shift = (rand - 0.5) * 0.3 * uIntensity * doShift;
    vec2 q = vec2(fract(uv.x + shift), uv.y);
    vec4 c = texture(uSrc, q);
    // Channel scramble on strong glitches
    float swap = step(0.9, rand) * uIntensity;
    return vec4(mix(c.rgb, c.gbr, swap), c.a);
}
