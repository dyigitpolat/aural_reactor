"""Modulation matrix evaluator.

Takes (SignalBundle + list[Patch]) and bakes them into per-target-parameter
time-series arrays, ready to be sampled per frame in the renderer or streamed
to the preview.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from backend.app.audio.signals import DISCRETE_TRIGGERS, SignalBundle
from backend.app.project.models import Patch
from backend.app.routing.transforms import apply_chain, events_to_envelope


@dataclass
class BakedModulation:
    rate_hz: float
    duration: float
    targets: dict[str, np.ndarray]  # target name ("zoom.intensity") -> float32[n]

    def sample(self, target: str, t: float) -> float:
        arr = self.targets.get(target)
        if arr is None or arr.size == 0:
            return 0.0
        idx = int(round(t * self.rate_hz))
        idx = max(0, min(arr.size - 1, idx))
        return float(arr[idx])


def _get_source_array(bundle: SignalBundle, source: str) -> np.ndarray:
    if source in bundle.continuous:
        arr = bundle.continuous[source]
        return arr.astype(np.float32, copy=False)

    if source in DISCRETE_TRIGGERS:
        events = bundle.events.get(source, [])
        return events_to_envelope(
            events=list(events),
            duration=bundle.duration,
            rate_hz=bundle.rate_hz,
        )

    # Unknown source → zeros
    n = int(round(bundle.duration * bundle.rate_hz))
    return np.zeros(n, dtype=np.float32)


def _section_gate(bundle: SignalBundle, section_mask: list[int], n: int) -> np.ndarray:
    """Return a [0,1] gate that's 1 where any of `section_mask` indices is
    active in the song, 0 elsewhere.

    Uses pre-computed `section_N_active` continuous signals from the bundle.
    """
    gate = np.zeros(n, dtype=np.float32)
    for s_idx in section_mask:
        key = f"section_{s_idx}_active"
        sig = bundle.continuous.get(key)
        if sig is None:
            continue
        if sig.size != n:
            if sig.size > n:
                sig = sig[:n]
            else:
                pad = np.zeros(n - sig.size, dtype=np.float32)
                sig = np.concatenate([sig, pad])
        gate = np.maximum(gate, sig)
    return gate


def bake(bundle: SignalBundle, patches: list[Patch]) -> BakedModulation:
    """Evaluate all patches and return one time-series per target parameter."""
    targets: dict[str, np.ndarray] = {}
    n = int(round(bundle.duration * bundle.rate_hz))

    for patch in patches:
        if not patch.enabled:
            continue
        src = _get_source_array(bundle, patch.source)
        if src.size == 0:
            continue
        if src.size != n:
            # Pad / truncate to the canonical grid
            if src.size > n:
                src = src[:n]
            else:
                pad = np.zeros(n - src.size, dtype=np.float32)
                src = np.concatenate([src, pad])

        modulated = apply_chain(
            src,
            rate_hz=bundle.rate_hz,
            smooth_ms=patch.smooth_ms,
            gate_threshold=patch.gate_threshold,
            curve_kind=patch.curve,
            scale_min=patch.scale_min,
            scale_max=patch.scale_max,
            latch_ms=patch.latch_ms,
        )

        # Section gating: zero the modulated signal outside the patch's
        # allowed sections. This is how a patch says "only fire during the
        # chorus" or "only during intro + outro".
        if patch.section_mask:
            gate = _section_gate(bundle, patch.section_mask, n)
            modulated = modulated * gate

        existing = targets.get(patch.target)
        if existing is None:
            targets[patch.target] = modulated.copy()
        else:
            # Multiple patches → take max (additive would blow past the unit range
            # for most effect uniforms; max is more predictable).
            targets[patch.target] = np.maximum(existing, modulated)

    return BakedModulation(
        rate_hz=bundle.rate_hz,
        duration=bundle.duration,
        targets=targets,
    )
