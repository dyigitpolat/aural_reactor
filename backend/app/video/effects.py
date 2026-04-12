"""Effect registry + uniform schemas.

Each effect is declared once here. Both the Python ModernGL renderer and the
browser PixiJS preview consume this registry (browser gets it via the
`/api/effects` endpoint). Adding a new effect = drop a .frag into
shared/shaders/ and register it here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from backend.app.config import settings


@dataclass
class UniformSpec:
    name: str  # e.g. "uIntensity"
    param: str  # public parameter name, e.g. "intensity"
    default: float
    min: float = 0.0
    max: float = 1.0
    description: str = ""


@dataclass
class EffectSpec:
    name: str
    shader_file: str  # filename under shared/shaders
    order: int  # canonical position in the chain
    uniforms: list[UniformSpec] = field(default_factory=list)
    description: str = ""
    # Set True for effects that need a "previous frame" texture input (feedback).
    needs_prev_frame: bool = False

    def load_body(self) -> str:
        path = settings.shaders_dir / self.shader_file
        return path.read_text(encoding="utf-8")

    def default_params(self) -> dict[str, float]:
        return {u.param: u.default for u in self.uniforms}


# Ordered from "closest to the raw clip" to "final polish".
EFFECTS: list[EffectSpec] = [
    EffectSpec(
        name="zoom",
        shader_file="zoom.frag",
        order=10,
        description="Zoom punch toward a center point.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0, "Zoom amount"),
            UniformSpec("uCenterX", "centerX", 0.5, 0.0, 1.0, "Zoom center X"),
            UniformSpec("uCenterY", "centerY", 0.5, 0.0, 1.0, "Zoom center Y"),
        ],
    ),
    EffectSpec(
        name="shake",
        shader_file="shake.frag",
        order=20,
        description="Camera shake offset.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uFreq", "freq", 6.0, 1.0, 30.0, "Shake frequency"),
        ],
    ),
    EffectSpec(
        name="rgb_split",
        shader_file="rgb_split.frag",
        order=30,
        description="Radial chromatic aberration.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uAngle", "angle", 0.0, 0.0, 6.28318, "Split angle"),
        ],
    ),
    EffectSpec(
        name="glitch",
        shader_file="glitch.frag",
        order=40,
        description="Horizontal slice displacement + channel scramble.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uSeed", "seed", 3.14, 0.0, 100.0),
        ],
    ),
    EffectSpec(
        name="pixelate",
        shader_file="pixelate.frag",
        order=50,
        description="Tile-based pixelation.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uAspect", "aspect", 16.0 / 9.0, 0.5, 3.0),
        ],
    ),
    EffectSpec(
        name="kaleidoscope",
        shader_file="kaleidoscope.frag",
        order=60,
        description="N-fold radial symmetry.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uSegments", "segments", 6.0, 2.0, 16.0),
            UniformSpec("uRotation", "rotation", 0.0, 0.0, 6.28318),
        ],
    ),
    EffectSpec(
        name="contrast_pump",
        shader_file="contrast_pump.frag",
        order=70,
        description="Side-chain contrast + saturation pump.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uSaturation", "saturation", 0.3, 0.0, 1.0),
        ],
    ),
    EffectSpec(
        name="bloom",
        shader_file="bloom.frag",
        order=80,
        description="Threshold-based bloom glow.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uThreshold", "threshold", 0.75, 0.0, 1.0),
        ],
    ),
    EffectSpec(
        name="light_leak",
        shader_file="light_leak.frag",
        order=28,
        description="Warm radial light-leak overlay.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uHue", "hue", 0.08, 0.0, 1.0),
        ],
    ),
    EffectSpec(
        name="feedback",
        shader_file="feedback.frag",
        order=100,
        needs_prev_frame=True,
        description="Feedback / echo trail.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.0, 0.0, 1.0),
            UniformSpec("uZoom", "zoom", 1.0, 0.0, 4.0),
        ],
    ),
    EffectSpec(
        name="grain",
        shader_file="grain.frag",
        order=110,
        description="Animated film grain.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.12, 0.0, 1.0),
            UniformSpec("uSize", "size", 0.5, 0.1, 2.0),
        ],
    ),
    EffectSpec(
        name="vignette",
        shader_file="vignette.frag",
        order=25,
        description="Vignette + exposure.",
        uniforms=[
            UniformSpec("uIntensity", "intensity", 0.25, 0.0, 1.0),
            UniformSpec("uExposure", "exposure", 0.0, -0.5, 0.5),
        ],
    ),
]


# Mandatory prelude that runs before the user's effect chain in both the
# browser preview and the Python render pipeline. Not listed in EFFECTS /
# effect_schema so it doesn't show up in the UI modulation matrix.
SOURCE_FIT_SPEC = EffectSpec(
    name="source_fit",
    shader_file="source_fit.frag",
    order=-1,
    description="Center-crop source frame to output aspect (prelude).",
    uniforms=[
        UniformSpec("uClipAspect", "clipAspect", 16.0 / 9.0, 0.1, 10.0),
        UniformSpec("uOutputAspect", "outputAspect", 16.0 / 9.0, 0.1, 10.0),
    ],
)


EFFECT_BY_NAME: dict[str, EffectSpec] = {e.name: e for e in EFFECTS}
EFFECT_BY_NAME[SOURCE_FIT_SPEC.name] = SOURCE_FIT_SPEC


def effect_order() -> list[str]:
    return [e.name for e in sorted(EFFECTS, key=lambda e: e.order)]


def effect_schema() -> list[dict]:
    """JSON-friendly schema for the frontend."""
    out: list[dict] = []
    for e in EFFECTS:
        out.append(
            {
                "name": e.name,
                "order": e.order,
                "description": e.description,
                "needs_prev_frame": e.needs_prev_frame,
                "uniforms": [
                    {
                        "name": u.name,
                        "param": u.param,
                        "default": u.default,
                        "min": u.min,
                        "max": u.max,
                        "description": u.description,
                    }
                    for u in e.uniforms
                ],
            }
        )
    return out


def load_shader_body(name: str) -> str:
    spec = EFFECT_BY_NAME.get(name)
    if spec is None:
        raise KeyError(f"unknown effect {name}")
    return spec.load_body()


def load_common() -> str:
    path = settings.shaders_dir / "common.glsl"
    return path.read_text(encoding="utf-8")


# GLSL header templates for each platform ----------------------------------

MODERNGL_VERTEX = """
#version 330 core
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
    vUv = aUv;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
"""

MODERNGL_FRAGMENT_TEMPLATE = """
#version 330 core
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform float uTime;
{COMMON}
{BODY}
void main() {
    fragColor = apply(vUv, uTime);
}
"""

WEBGL_FRAGMENT_TEMPLATE = """
#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform float uTime;
{COMMON}
{BODY}
void main() {
    fragColor = apply(vUv, uTime);
}
"""


def build_fragment(effect_name: str, target: str) -> str:
    """Assemble a full fragment shader for either 'gl' (ModernGL) or 'webgl').

    `.lstrip()` is mandatory: GLSL ES 3.00 requires `#version 300 es` to be
    the very first non-whitespace token on line 1. The template strings start
    with a leading newline (triple-quoted convention) which pushes #version
    to line 2 and makes strict WebGL compilers reject the shader with
    "ERROR: 0:2: ' ' : #version". Desktop GLSL 330 is lenient about this so
    backend tests passed while the browser always failed.
    """
    common = load_common()
    body = load_shader_body(effect_name)
    if target == "gl":
        tmpl = MODERNGL_FRAGMENT_TEMPLATE
    elif target == "webgl":
        tmpl = WEBGL_FRAGMENT_TEMPLATE
    else:
        raise ValueError(f"unknown shader target {target}")
    return tmpl.replace("{COMMON}", common).replace("{BODY}", body).lstrip()
