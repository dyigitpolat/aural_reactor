"""Drop detector.

Heuristic: a "drop" is a point where loudness and spectral flux both spike
relative to the preceding second, typically after a buildup (rising flux or
falling RMS). We score each frame and pick local maxima above a threshold
with a cooldown.
"""
from __future__ import annotations

import numpy as np


def detect_drops(
    rms: np.ndarray,
    flux: np.ndarray,
    rate_hz: float,
    min_gap_s: float = 8.0,
    threshold: float = 0.55,
) -> list[float]:
    """Return drop times in seconds.

    `rms` and `flux` are already normalized to [0, 1] and on the rate_hz grid.
    """
    if rms.size == 0 or flux.size == 0:
        return []

    n = min(rms.size, flux.size)
    rms = rms[:n]
    flux = flux[:n]

    look_back = max(1, int(round(rate_hz * 1.0)))  # 1s lookback
    # Ascending RMS delta over the last second
    rms_shift = np.concatenate([np.zeros(look_back, dtype=rms.dtype), rms[:-look_back]])
    rms_delta = np.clip(rms - rms_shift, 0.0, 1.0)

    score = 0.55 * rms_delta + 0.35 * flux + 0.10 * rms
    # Boost: near-silent buildup preceding the hit.
    silent_before = np.concatenate(
        [np.zeros(look_back, dtype=rms.dtype), 1.0 - rms[:-look_back]]
    )
    score = score * (0.5 + 0.5 * silent_before)

    # Local-max + threshold + cooldown.
    drops: list[float] = []
    cooldown = int(round(rate_hz * min_gap_s))
    last_fire = -cooldown
    for i in range(1, n - 1):
        if i - last_fire < cooldown:
            continue
        if score[i] < threshold:
            continue
        if score[i] >= score[i - 1] and score[i] >= score[i + 1]:
            drops.append(i / rate_hz)
            last_fire = i
    return drops
