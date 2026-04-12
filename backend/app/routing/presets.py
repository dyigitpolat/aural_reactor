"""Style presets.

A preset is a saved `(effect_chain, patches)` config that applies over the
project on click. Each preset is a pure-data dict of
`{effect_chain: [...], patches: [...]}` so they can round-trip through JSON.
"""
from __future__ import annotations

import uuid

from backend.app.project.models import EffectChainEntry, Patch


def _patch(source: str, target: str, **kw) -> Patch:
    base = dict(
        id=uuid.uuid4().hex[:8],
        source=source,
        target=target,
        enabled=True,
        smooth_ms=0.0,
        gate_threshold=0.0,
        curve="linear",
        scale_min=0.0,
        scale_max=1.0,
        latch_ms=0.0,
    )
    base.update(kw)
    return Patch(**base)


def _chain(names: list[str], base_params: dict[str, dict[str, float]] | None = None) -> list[EffectChainEntry]:
    bp = base_params or {}
    return [
        EffectChainEntry(name=n, enabled=True, base_params=bp.get(n, {})) for n in names
    ]


PRESETS: dict[str, dict] = {
    "cinematic": {
        "description": "Subtle zoom pumps on downbeats, warm vignette, minimal grain.",
        "effect_chain": _chain(
            ["zoom", "contrast_pump", "bloom", "grain", "vignette"],
            base_params={
                "vignette": {"intensity": 0.35, "exposure": -0.05},
                "grain": {"intensity": 0.08},
                "bloom": {"intensity": 0.25, "threshold": 0.78},
            },
        ),
        "patches": [
            _patch("downbeat", "zoom.intensity", smooth_ms=60.0, latch_ms=100.0, scale_max=0.5, curve="exp"),
            _patch("bass_energy", "contrast_pump.intensity", smooth_ms=80.0, scale_max=0.45),
        ],
    },
    "lofi_vhs": {
        "description": "VHS haze — grain, glitch, chromatic aberration, warm leak.",
        "effect_chain": _chain(
            ["rgb_split", "glitch", "light_leak", "grain", "vignette"],
            base_params={
                "rgb_split": {"intensity": 0.15, "angle": 0.0},
                "glitch": {"intensity": 0.05},
                "light_leak": {"intensity": 0.2, "hue": 0.08},
                "grain": {"intensity": 0.35},
                "vignette": {"intensity": 0.45, "exposure": -0.08},
            },
        ),
        "patches": [
            _patch("spectral_flux", "glitch.intensity", smooth_ms=40.0, gate_threshold=0.5, scale_max=0.6, curve="exp"),
            _patch("rms", "light_leak.intensity", smooth_ms=200.0, scale_max=0.5),
        ],
    },
    "festival_edm": {
        "description": "Big drops — zoom punches, RGB split bursts, strobe pump.",
        "effect_chain": _chain(
            ["zoom", "shake", "rgb_split", "contrast_pump", "bloom", "vignette"],
            base_params={
                "bloom": {"intensity": 0.35, "threshold": 0.7},
                "vignette": {"intensity": 0.25},
            },
        ),
        "patches": [
            _patch("kick_hit", "zoom.intensity", smooth_ms=20.0, latch_ms=80.0, scale_max=0.9, curve="exp"),
            _patch("kick_hit", "contrast_pump.intensity", smooth_ms=20.0, latch_ms=60.0, scale_max=0.75),
            _patch("snare_hit", "shake.intensity", smooth_ms=15.0, latch_ms=50.0, scale_max=0.6),
            _patch("hi_hat_hit", "rgb_split.intensity", smooth_ms=10.0, latch_ms=30.0, scale_max=0.5),
            _patch("drop_detected", "bloom.intensity", smooth_ms=50.0, latch_ms=400.0, scale_max=0.9, curve="exp"),
        ],
    },
    "amv": {
        "description": "AMV kit — beat cuts, feedback trails, saturated pump.",
        "effect_chain": _chain(
            ["zoom", "feedback", "contrast_pump", "bloom", "grain"],
            base_params={
                "contrast_pump": {"intensity": 0.2, "saturation": 0.5},
                "bloom": {"intensity": 0.2, "threshold": 0.8},
                "grain": {"intensity": 0.1},
            },
        ),
        "patches": [
            _patch("beat", "zoom.intensity", smooth_ms=30.0, latch_ms=80.0, scale_max=0.5, curve="exp"),
            _patch("vocal_onset", "feedback.intensity", smooth_ms=80.0, latch_ms=500.0, scale_max=0.55),
            _patch("rms", "contrast_pump.intensity", smooth_ms=120.0, scale_min=0.1, scale_max=0.45),
        ],
    },
    "horror": {
        "description": "Creeping kaleidoscope, heavy vignette, rare glitch stabs.",
        "effect_chain": _chain(
            ["kaleidoscope", "rgb_split", "glitch", "contrast_pump", "vignette", "grain"],
            base_params={
                "kaleidoscope": {"intensity": 0.0, "segments": 6.0, "rotation": 0.0},
                "vignette": {"intensity": 0.6, "exposure": -0.15},
                "grain": {"intensity": 0.25},
                "contrast_pump": {"intensity": 0.1, "saturation": 0.2},
            },
        ),
        "patches": [
            _patch("harmonicity", "kaleidoscope.intensity", smooth_ms=200.0, scale_max=0.6),
            _patch("spectral_flux", "glitch.intensity", gate_threshold=0.7, latch_ms=150.0, scale_max=0.9),
            _patch("bass_energy", "rgb_split.intensity", smooth_ms=100.0, scale_max=0.35),
        ],
    },
}


def list_presets() -> list[dict]:
    return [
        {"name": k, "description": v["description"]}
        for k, v in PRESETS.items()
    ]


def apply_preset(name: str) -> tuple[list[EffectChainEntry], list[Patch]]:
    if name not in PRESETS:
        raise KeyError(name)
    p = PRESETS[name]
    # Copy so callers can mutate freely
    chain = [EffectChainEntry.model_validate(e.model_dump()) for e in p["effect_chain"]]
    # Patches have unique ids per application
    patches: list[Patch] = []
    for patch in p["patches"]:
        d = patch.model_dump()
        d["id"] = uuid.uuid4().hex[:8]
        patches.append(Patch(**d))
    return chain, patches
