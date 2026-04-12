"""Beat + downbeat detection.

Beat tracking: madmom RNN+DBN (primary), librosa beat_track (fallback).
Downbeat inference: onset/bass-weighted phase-offset picker over the beat
list, using the project's `beats_per_bar` setting. Downbeats are ALWAYS
exact entries from the beat list — alignment is guaranteed by construction.
"""
from __future__ import annotations

import logging

import librosa
import numpy as np

log = logging.getLogger(__name__)


def _has_madmom() -> bool:
    try:
        import madmom  # noqa: F401
        return True
    except Exception:
        return False


def _detect_beats_madmom(
    y: np.ndarray, sr: int, fps: int = 100
) -> tuple[float, list[float]] | None:
    try:
        from madmom.audio.signal import Signal
        from madmom.features.beats import DBNBeatTrackingProcessor, RNNBeatProcessor
    except Exception as e:
        log.warning("madmom import failed: %s", e)
        return None
    try:
        sig = Signal(y.astype(np.float32), sample_rate=sr, num_channels=1)
        act = RNNBeatProcessor()(sig)
        beat_times = DBNBeatTrackingProcessor(min_bpm=55.0, max_bpm=215.0, fps=fps)(act)
    except Exception as e:
        log.warning("madmom beat tracking failed: %s", e)
        return None
    beat_times = [float(t) for t in np.asarray(beat_times).tolist()]
    if len(beat_times) < 2:
        return 0.0, beat_times
    tempo = float(60.0 / np.median(np.diff(beat_times)))
    return tempo, beat_times


def _detect_beats_librosa(
    y: np.ndarray, sr: int, hop_length: int, start_bpm: float | None
) -> tuple[float, list[float]]:
    kw: dict = {"y": y, "sr": sr, "hop_length": hop_length, "units": "frames", "tightness": 100}
    if start_bpm is not None and start_bpm > 0:
        kw["start_bpm"] = float(start_bpm)
    tempo, beat_frames = librosa.beat.beat_track(**kw)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length).tolist()
    tempo_value = float(tempo if np.isscalar(tempo) else np.atleast_1d(tempo)[0])
    return tempo_value, beat_times


def detect_beats(
    y: np.ndarray,
    sr: int,
    hop_length: int = 512,
    start_bpm: float | None = None,
) -> tuple[float, list[float]]:
    """Return (tempo_bpm, beat_times). madmom → librosa fallback."""
    if y.size == 0:
        return 0.0, []
    if _has_madmom():
        result = _detect_beats_madmom(y, sr)
        if result is not None and result[1]:
            return result
        log.warning("madmom beat tracking empty; falling back to librosa")
    return _detect_beats_librosa(y, sr, hop_length, start_bpm)


def infer_downbeats(
    y_full: np.ndarray,
    sr: int,
    beat_times: list[float],
    beats_per_bar: int = 4,
    bass_stem: np.ndarray | None = None,
    hop_length: int = 512,
) -> list[float]:
    """Return downbeat times — always exact entries from `beat_times`.

    Picks the bar-phase offset whose beats carry the most onset + bass
    weight, then returns every `beats_per_bar`-th beat starting from that
    offset. Alignment with beat_times is guaranteed by construction.
    """
    if not beat_times or beats_per_bar < 1:
        return []

    onset_env = librosa.onset.onset_strength(y=y_full, sr=sr, hop_length=hop_length)
    frame_rate = sr / hop_length

    bass_at: list[float] = []
    if bass_stem is not None and bass_stem.size > 0:
        bass_env = librosa.feature.rms(y=bass_stem, hop_length=hop_length)[0]
        for t in beat_times:
            idx = int(round(t * frame_rate))
            lo = max(0, idx - 2)
            hi = min(bass_env.size, idx + 3)
            bass_at.append(float(bass_env[lo:hi].mean()) if hi > lo else 0.0)
    else:
        bass_at = [0.0] * len(beat_times)

    onset_at: list[float] = []
    for t in beat_times:
        idx = int(round(t * frame_rate))
        lo = max(0, idx - 3)
        hi = min(onset_env.size, idx + 4)
        onset_at.append(float(onset_env[lo:hi].max()) if hi > lo else 0.0)

    def _norm(xs: list[float]) -> list[float]:
        mx = max(xs) if xs else 0.0
        return [x / mx for x in xs] if mx > 0 else xs

    onset_n = _norm(onset_at)
    bass_n = _norm(bass_at)

    n = len(beat_times)
    best_offset = 0
    best_sum = -1.0
    for offset in range(min(beats_per_bar, n)):
        s = 0.0
        for i in range(offset, n, beats_per_bar):
            s += onset_n[i] + 0.6 * bass_n[i]
        if s > best_sum:
            best_sum = s
            best_offset = offset

    return [beat_times[i] for i in range(best_offset, n, beats_per_bar)]
