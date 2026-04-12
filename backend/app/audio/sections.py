"""Structural segmentation via librosa's laplacian method.

Replaces msaf (unmaintained on Python 3.12). Returns a list of sections with
rough labels (A/B/C/...) and per-section energy.
"""
from __future__ import annotations

import librosa
import numpy as np

from backend.app.audio.signals import Section


def segment(
    y: np.ndarray,
    sr: int,
    rms: np.ndarray,
    rate_hz: float,
    hop_length: int = 512,
    k: int = 5,
) -> list[Section]:
    """Run spectral clustering on a self-similarity matrix and return `k` sections.

    `rms` is the [0..1] normalized envelope already on the rate_hz grid, used
    for per-section energy scoring.
    """
    duration = float(len(y)) / sr
    if duration < 4.0:
        return [Section(start=0.0, end=duration, label="A", energy=float(np.mean(rms)))]

    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
        bounds_frames = librosa.segment.agglomerative(chroma, k=max(2, k))
        bounds_times = librosa.frames_to_time(bounds_frames, sr=sr, hop_length=hop_length).tolist()
    except Exception:
        # Fall back to uniform cuts if segmentation barfs.
        step = duration / max(k, 1)
        bounds_times = [i * step for i in range(k)]

    if 0.0 not in bounds_times[:1]:
        bounds_times = [0.0] + bounds_times
    bounds_times.append(duration)
    bounds_times = sorted(set(round(b, 3) for b in bounds_times))

    sections: list[Section] = []
    label_alphabet = "ABCDEFGHIJKLMNOP"
    for i in range(len(bounds_times) - 1):
        start, end = bounds_times[i], bounds_times[i + 1]
        if end - start < 1.0:
            continue
        lo = int(start * rate_hz)
        hi = min(rms.size, int(end * rate_hz))
        energy = float(rms[lo:hi].mean()) if hi > lo else 0.0
        sections.append(
            Section(start=start, end=end, label=label_alphabet[i % len(label_alphabet)], energy=energy)
        )
    return sections
