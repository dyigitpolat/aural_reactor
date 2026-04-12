// Phase 0 placeholder effect. Phase 3 replaces with the full 12-effect chain.
#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uIntensity;

void main() {
    vec4 c = texture(uTexture, vUv);
    outColor = c;
}
