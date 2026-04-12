"""Modulation matrix tests."""
from __future__ import annotations

import numpy as np

from backend.app.audio.signals import SignalBundle
from backend.app.project.models import Patch
from backend.app.routing.matrix import bake
from backend.app.routing.transforms import (
    apply_chain,
    curve,
    events_to_envelope,
    gate,
    latch,
    scale,
    smooth,
)


def _bundle() -> SignalBundle:
    rate_hz = 100.0
    duration = 4.0
    rms = np.linspace(0.0, 1.0, int(duration * rate_hz)).astype(np.float32)
    return SignalBundle(
        duration=duration,
        sr=22050,
        rate_hz=rate_hz,
        tempo_bpm=120.0,
        continuous={"rms": rms},
        events={"drop_detected": [0.5, 1.5, 2.5, 3.5]},
        beat_times=[],
        downbeat_times=[],
    )


def test_smooth_converges_to_constant_input():
    x = np.full(100, 0.7, dtype=np.float32)
    y = smooth(x, rate_hz=100.0, tau_ms=20.0)
    assert abs(float(y[-1]) - 0.7) < 0.01


def test_gate_zeroes_below_threshold():
    x = np.array([0.0, 0.3, 0.6, 0.9], dtype=np.float32)
    y = gate(x, 0.5)
    assert y[0] == 0.0
    assert y[1] == 0.0
    assert y[2] > 0.0
    assert y[3] > y[2]


def test_curve_s_is_monotonic():
    x = np.linspace(0, 1, 11, dtype=np.float32)
    for kind in ("linear", "exp", "log", "s"):
        y = curve(x, kind)
        assert all(y[i + 1] >= y[i] - 1e-6 for i in range(len(y) - 1))


def test_scale_maps_to_range():
    x = np.array([0.0, 0.5, 1.0], dtype=np.float32)
    y = scale(x, 0.2, 0.8)
    assert abs(y[0] - 0.2) < 1e-6
    assert abs(y[1] - 0.5) < 1e-6
    assert abs(y[2] - 0.8) < 1e-6


def test_latch_holds_peaks():
    x = np.array([0.0, 1.0, 0.0, 0.0, 0.0, 0.0], dtype=np.float32)
    y = latch(x, rate_hz=100.0, hold_ms=30.0)
    # Peak should be held at 1.0 for ~3 samples
    assert float(y[1]) == 1.0
    assert float(y[2]) == 1.0
    assert float(y[3]) >= 0.9  # still held


def test_events_to_envelope_spikes_then_decays():
    env = events_to_envelope([0.1, 0.3], duration=0.5, rate_hz=100.0, half_life_ms=50.0)
    assert env.size == 50
    # Spike at idx 10 and 30
    assert env[10] == 1.0
    assert env[30] == 1.0
    # Between spikes, decayed
    assert 0.0 < env[20] < 1.0


def test_bake_continuous_source():
    b = _bundle()
    patch = Patch(
        id="p1",
        source="rms",
        target="zoom.intensity",
        scale_min=0.1,
        scale_max=0.9,
    )
    baked = bake(b, [patch])
    assert "zoom.intensity" in baked.targets
    arr = baked.targets["zoom.intensity"]
    assert abs(float(arr[0]) - 0.1) < 0.01
    assert abs(float(arr[-1]) - 0.9) < 0.01


def test_bake_discrete_trigger_source():
    b = _bundle()
    patch = Patch(
        id="p1",
        source="drop_detected",
        target="shake.intensity",
        latch_ms=100.0,
        scale_max=0.6,
    )
    baked = bake(b, [patch])
    arr = baked.targets["shake.intensity"]
    assert float(arr.max()) > 0.5  # peak near scale_max
    assert float(arr[0]) < 0.1  # pre-first-kick silence


def test_bake_max_on_overlapping_patches():
    b = _bundle()
    p1 = Patch(id="p1", source="rms", target="zoom.intensity", scale_max=0.4)
    p2 = Patch(id="p2", source="drop_detected", target="zoom.intensity", latch_ms=80.0, scale_max=0.9)
    baked = bake(b, [p1, p2])
    arr = baked.targets["zoom.intensity"]
    # Kick peak should dominate
    assert float(arr.max()) > 0.8


def test_apply_chain_is_deterministic():
    x = np.linspace(0, 1, 100, dtype=np.float32)
    y1 = apply_chain(x, rate_hz=100.0, smooth_ms=10.0, gate_threshold=0.2, curve_kind="s",
                    scale_min=0.0, scale_max=1.0, latch_ms=0.0)
    y2 = apply_chain(x, rate_hz=100.0, smooth_ms=10.0, gate_threshold=0.2, curve_kind="s",
                    scale_min=0.0, scale_max=1.0, latch_ms=0.0)
    assert np.allclose(y1, y2)
