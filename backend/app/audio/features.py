"""Spectral + envelope features from librosa. Frames are resampled to a fixed rate_hz."""
from __future__ import annotations

import librosa
import numpy as np


def _resample_to_rate(arr: np.ndarray, src_times: np.ndarray, rate_hz: float, duration: float) -> np.ndarray:
    n = int(round(duration * rate_hz))
    if n <= 0 or arr.size == 0:
        return np.zeros(max(n, 0), dtype=np.float32)
    t_out = np.arange(n) / rate_hz
    return np.interp(t_out, src_times, arr).astype(np.float32)


def _norm01(arr: np.ndarray) -> np.ndarray:
    if arr.size == 0:
        return arr
    lo = float(np.percentile(arr, 2.0))
    hi = float(np.percentile(arr, 98.0))
    if hi - lo < 1e-9:
        return np.zeros_like(arr)
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)


def extract_features(
    y: np.ndarray,
    sr: int,
    rate_hz: float,
    hop_length: int = 512,
) -> dict[str, np.ndarray]:
    """Extract per-frame features and resample them all to a common `rate_hz` grid.

    Returns a dict of {name: np.ndarray} where every array has the same length.
    All arrays are normalized to [0, 1] using robust percentile scaling.
    """
    duration = float(len(y)) / sr

    # STFT-derived
    stft = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop_length))
    rms = librosa.feature.rms(S=stft, hop_length=hop_length)[0]
    centroid = librosa.feature.spectral_centroid(S=stft, sr=sr, hop_length=hop_length)[0]
    flux = librosa.onset.onset_strength(S=librosa.amplitude_to_db(stft, ref=np.max), sr=sr, hop_length=hop_length)

    # Frequency band energies via mel bands (simpler + robust)
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=64, hop_length=hop_length, fmax=sr / 2)
    mel_db = librosa.power_to_db(mel, ref=np.max)
    # Bass: 20-250Hz, Mid: 250-4000Hz, Treble: 4000Hz+
    mel_freqs = librosa.mel_frequencies(n_mels=64, fmax=sr / 2)
    bass_mask = mel_freqs < 250.0
    mid_mask = (mel_freqs >= 250.0) & (mel_freqs < 4000.0)
    treble_mask = mel_freqs >= 4000.0
    bass = mel_db[bass_mask].mean(axis=0) if bass_mask.any() else np.zeros(mel_db.shape[1])
    mid = mel_db[mid_mask].mean(axis=0) if mid_mask.any() else np.zeros(mel_db.shape[1])
    treble = mel_db[treble_mask].mean(axis=0) if treble_mask.any() else np.zeros(mel_db.shape[1])

    # Harmonic/percussive split for "harmonicity" vs "percussiveness"
    y_h, y_p = librosa.effects.hpss(y, margin=3.0)
    h_rms = librosa.feature.rms(y=y_h, hop_length=hop_length)[0]
    p_rms = librosa.feature.rms(y=y_p, hop_length=hop_length)[0]

    # All of the above share the same STFT frame axis.
    frame_times = librosa.frames_to_time(
        np.arange(rms.size), sr=sr, hop_length=hop_length
    )

    def to_grid(arr: np.ndarray) -> np.ndarray:
        return _resample_to_rate(arr, frame_times, rate_hz, duration)

    return {
        "rms": _norm01(to_grid(rms)),
        "spectral_centroid": _norm01(to_grid(centroid)),
        "spectral_flux": _norm01(to_grid(flux)),
        "bass_energy": _norm01(to_grid(bass)),
        "mid_energy": _norm01(to_grid(mid)),
        "treble_energy": _norm01(to_grid(treble)),
        "harmonicity": _norm01(to_grid(h_rms)),
        "percussiveness": _norm01(to_grid(p_rms)),
    }


def extract_rms_envelope(y: np.ndarray, sr: int, rate_hz: float, hop_length: int = 512) -> np.ndarray:
    """Standalone per-stem RMS envelope on the same rate_hz grid."""
    duration = float(len(y)) / sr
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    frame_times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=hop_length)
    return _norm01(_resample_to_rate(rms, frame_times, rate_hz, duration))
