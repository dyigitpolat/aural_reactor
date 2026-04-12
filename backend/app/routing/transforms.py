"""Transform chain applied to a signal before it reaches a target parameter.

Order: events_to_env → smooth → gate → curve → scale → latch

All functions take a float32 ndarray in [0, 1] and return one in [0, 1].
"""
from __future__ import annotations

import numpy as np


def events_to_envelope(events: list[float], duration: float, rate_hz: float, half_life_ms: float = 180.0) -> np.ndarray:
    """Convert a list of event times into an exponential-decay envelope.

    Each event spikes to 1.0 and decays with the given half-life.
    """
    n = int(round(duration * rate_hz))
    env = np.zeros(n, dtype=np.float32)
    if not events or n == 0:
        return env
    decay = float(np.exp(-np.log(2.0) / max(1.0, (half_life_ms / 1000.0) * rate_hz)))
    idxs = np.clip(np.round(np.asarray(events) * rate_hz).astype(np.int64), 0, n - 1)
    for i in idxs:
        env[i] = 1.0
    # Forward-pass exponential decay combining overlaps (max, not sum).
    for i in range(1, n):
        prev = env[i - 1] * decay
        if prev > env[i]:
            env[i] = prev
    return env


def smooth(arr: np.ndarray, rate_hz: float, tau_ms: float) -> np.ndarray:
    """Single-pole lowpass smoothing."""
    if tau_ms <= 0.0 or arr.size == 0:
        return arr
    tau_samples = max(1.0, (tau_ms / 1000.0) * rate_hz)
    alpha = float(1.0 - np.exp(-1.0 / tau_samples))
    out = np.empty_like(arr)
    acc = float(arr[0])
    for i in range(arr.size):
        acc += alpha * (float(arr[i]) - acc)
        out[i] = acc
    return out


def gate(arr: np.ndarray, threshold: float) -> np.ndarray:
    if threshold <= 0.0:
        return arr
    out = arr.copy()
    out[out < threshold] = 0.0
    # Re-normalize above-threshold values back into [0, 1]
    if threshold < 1.0:
        mask = out > 0.0
        out[mask] = (out[mask] - threshold) / (1.0 - threshold)
    return out


def curve(arr: np.ndarray, kind: str) -> np.ndarray:
    if kind == "linear":
        return arr
    if kind == "exp":
        return arr * arr
    if kind == "log":
        return np.sqrt(np.clip(arr, 0.0, 1.0))
    if kind == "s":
        return 3.0 * arr * arr - 2.0 * arr * arr * arr
    return arr


def scale(arr: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return lo + arr * (hi - lo)


def latch(arr: np.ndarray, rate_hz: float, hold_ms: float) -> np.ndarray:
    """Hold peak values for hold_ms then decay linearly back to the underlying signal."""
    if hold_ms <= 0.0 or arr.size == 0:
        return arr
    hold_samples = max(1, int(round((hold_ms / 1000.0) * rate_hz)))
    out = np.empty_like(arr)
    peak = float(arr[0])
    hold_left = 0
    for i in range(arr.size):
        v = float(arr[i])
        if v >= peak:
            peak = v
            hold_left = hold_samples
        else:
            if hold_left > 0:
                hold_left -= 1
            else:
                # Decay toward the current underlying value
                peak = max(v, peak * 0.98)
        out[i] = peak
    return out


def apply_chain(
    arr: np.ndarray,
    rate_hz: float,
    smooth_ms: float,
    gate_threshold: float,
    curve_kind: str,
    scale_min: float,
    scale_max: float,
    latch_ms: float,
) -> np.ndarray:
    x = smooth(arr, rate_hz, smooth_ms)
    x = gate(x, gate_threshold)
    x = curve(x, curve_kind)
    x = scale(x, scale_min, scale_max)
    x = latch(x, rate_hz, latch_ms)
    return x.astype(np.float32)
