"""Generic onset detection utilities.

The per-drum and per-vocal onset detectors have been removed — they
produced unreliable results on Demucs-separated stems. The continuous
stem RMS signals (drum_rms, bass_rms, vocal_rms) are used for modulation
instead, which gives smoother, more musically coherent effects.

The generic `detect_onsets` and `detect_band_onsets` functions are retained
for potential future use.
"""
from __future__ import annotations

import librosa
import numpy as np


def detect_onsets(
    y: np.ndarray,
    sr: int,
    hop_length: int = 512,
    backtrack: bool = True,
    delta: float = 0.07,
    wait: int = 3,
    pre_max: int = 3,
    post_max: int = 3,
    pre_avg: int = 3,
    post_avg: int = 5,
) -> list[float]:
    """Return onset times in seconds."""
    if y.size == 0:
        return []
    onset_frames = librosa.onset.onset_detect(
        y=y,
        sr=sr,
        hop_length=hop_length,
        backtrack=backtrack,
        delta=delta,
        wait=wait,
        pre_max=pre_max,
        post_max=post_max,
        pre_avg=pre_avg,
        post_avg=post_avg,
        units="frames",
    )
    return librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length).tolist()


def detect_band_onsets(
    y: np.ndarray,
    sr: int,
    fmin: float,
    fmax: float,
    hop_length: int = 512,
    delta: float = 0.07,
    wait: int = 4,
) -> list[float]:
    """Band-limit the audio, then run onset detection."""
    from scipy.signal import butter, sosfilt

    nyq = sr / 2
    lo = max(20.0, fmin) / nyq
    hi = min(nyq - 1.0, fmax) / nyq
    if hi <= lo:
        return []
    sos = butter(4, [lo, hi], btype="band", output="sos")
    y_band = sosfilt(sos, y).astype(np.float32)
    return detect_onsets(y_band, sr, hop_length=hop_length, delta=delta, wait=wait)
