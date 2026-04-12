"""Top-level audio analysis pipeline.

Order:
  1. load audio
  2. stem separation (demucs) — if enabled and installed
  3. beat tracking on the drum stem (or full-mix fallback)
  4. downbeat inference using full-mix onset + bass-stem RMS
  5. features (spectral + envelopes)
  6. per-drum onset detection on stems (kick/snare/hi-hat/vocal)
  7. structural segmentation
  8. section_N_active continuous signals
  9. drop detection

Caches the full `SignalBundle` by content hash in `storage/cache/audio/<sha>`.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import librosa
import numpy as np

from backend.app.audio.beats import detect_beats, infer_downbeats
from backend.app.audio.drop import detect_drops
from backend.app.audio.features import extract_features, extract_rms_envelope
from backend.app.audio.sections import segment
from backend.app.audio.signals import SignalBundle
from backend.app.audio.stems import has_demucs, separate_stems
from backend.app.config import settings

log = logging.getLogger(__name__)


def file_sha(path: Path, block: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(block):
            h.update(chunk)
    return h.hexdigest()[:16]


def cache_dir_for(sha: str, use_stems: bool) -> Path:
    suffix = "-stems" if use_stems else "-mix"
    return settings.cache_dir / "audio" / f"{sha}{suffix}"


MAX_SECTION_SIGNALS = 8


def analyze_audio(
    audio_path: Path,
    use_stems: bool = True,
    force: bool = False,
    progress: callable | None = None,
    beats_per_bar: int | None = None,
) -> SignalBundle:
    """Analyze `audio_path` and return a populated SignalBundle. Cached."""

    def step(msg: str, frac: float) -> None:
        log.info("analyze [%.0f%%] %s", frac * 100, msg)
        if progress is not None:
            try:
                progress(msg, frac)
            except Exception:
                pass

    sha = file_sha(audio_path)
    stems_allowed = use_stems and has_demucs()
    cdir = cache_dir_for(sha, stems_allowed)
    if cdir.exists() and not force:
        try:
            step("loading cached analysis", 1.0)
            return SignalBundle.from_disk(cdir)
        except Exception as e:
            log.warning("cache load failed, re-analyzing: %s", e)

    sr = settings.analysis_sr
    hop = settings.analysis_hop
    rate_hz = settings.signal_rate_hz

    step("loading audio", 0.02)
    y, sr_loaded = librosa.load(str(audio_path), sr=sr, mono=True)
    y = y.astype(np.float32)
    duration = float(len(y)) / sr_loaded

    # ─── Stems first so beat tracking can use the clean drum signal ─────
    stems: dict[str, np.ndarray] | None = None
    has_stems = False
    if stems_allowed:
        step("separating stems (demucs)", 0.10)
        stems_dir = settings.cache_dir / "stems" / sha
        stems = separate_stems(audio_path, stems_dir, sr=sr_loaded)
        has_stems = stems is not None

    # ─── Beat tracking — drum stem preferred for cleaner onset detection ──
    step("detecting beats", 0.40)
    if has_stems and stems is not None and "drums" in stems:
        tempo_bpm, beat_times = detect_beats(stems["drums"], sr_loaded, hop_length=hop)
    else:
        tempo_bpm, beat_times = detect_beats(y, sr_loaded, hop_length=hop)

    step("downbeat inference", 0.50)
    bass_stem = stems.get("bass") if (has_stems and stems is not None) else None
    bpb = beats_per_bar if beats_per_bar else 4
    downbeat_times = infer_downbeats(
        y_full=y,
        sr=sr_loaded,
        beat_times=beat_times,
        beats_per_bar=bpb,
        bass_stem=bass_stem,
        hop_length=hop,
    )

    # ─── Features ────────────────────────────────────────────────────────
    step("extracting features", 0.60)
    features = extract_features(y, sr_loaded, rate_hz=rate_hz, hop_length=hop)

    continuous: dict[str, np.ndarray] = dict(features)
    continuous["tempo"] = np.full(
        int(duration * rate_hz), float(tempo_bpm) / 200.0, dtype=np.float32
    )

    events: dict[str, list[float]] = {
        "beat": beat_times,
        "downbeat": downbeat_times,
        "bar_start": downbeat_times,
    }

    # ─── Per-stem envelopes (continuous signals, no discrete events) ────
    if has_stems and stems is not None:
        step("stem envelopes", 0.70)
        for name in ("drums", "bass", "vocals", "other"):
            if name in stems:
                env = extract_rms_envelope(
                    stems[name], sr_loaded, rate_hz=rate_hz, hop_length=hop
                )
                continuous[f"{name}_rms"] = env

    # ─── Structural segmentation + section-active signals ───────────────
    step("structural segmentation", 0.85)
    sections = segment(y, sr_loaded, rms=continuous["rms"], rate_hz=rate_hz, hop_length=hop)
    events["section_change"] = [s.start for s in sections[1:]]

    n_frames = int(duration * rate_hz)
    for i, sect in enumerate(sections[:MAX_SECTION_SIGNALS]):
        sig = np.zeros(n_frames, dtype=np.float32)
        lo = max(0, int(sect.start * rate_hz))
        hi = min(n_frames, int(sect.end * rate_hz))
        if hi > lo:
            sig[lo:hi] = 1.0
        continuous[f"section_{i}_active"] = sig

    # ─── Drops ───────────────────────────────────────────────────────────
    step("drop detection", 0.95)
    drops = detect_drops(rms=continuous["rms"], flux=continuous["spectral_flux"], rate_hz=rate_hz)
    events["drop_detected"] = drops

    bundle = SignalBundle(
        duration=duration,
        sr=sr_loaded,
        rate_hz=rate_hz,
        tempo_bpm=float(tempo_bpm),
        continuous=continuous,
        events=events,
        beat_times=beat_times,
        downbeat_times=downbeat_times,
        has_stems=has_stems,
    )
    bundle.sections = sections

    step("caching", 0.98)
    bundle.to_disk(cdir)

    step("done", 1.0)
    return bundle
