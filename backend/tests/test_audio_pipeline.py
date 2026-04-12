"""End-to-end test for the audio pipeline on a synthetic click track."""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.app.audio.pipeline import analyze_audio


def _synth_click_track(sr: int = 22050, duration: float = 8.0, bpm: float = 120.0) -> np.ndarray:
    """Generate a synthetic click track at `bpm` with bass stabs every 4 beats."""
    n = int(sr * duration)
    y = np.zeros(n, dtype=np.float32)

    beat_interval = 60.0 / bpm
    n_beats = int(duration / beat_interval)
    for i in range(n_beats):
        t = i * beat_interval
        idx = int(t * sr)
        if idx + 100 >= n:
            break
        # Click: 5ms noise burst
        click_len = int(0.005 * sr)
        y[idx : idx + click_len] += np.random.randn(click_len).astype(np.float32) * 0.5
        # Bass thump on every beat for low-freq content
        thump_len = int(0.08 * sr)
        t_thump = np.arange(thump_len) / sr
        y[idx : idx + thump_len] += (
            np.exp(-t_thump * 30.0) * np.sin(2 * np.pi * 55.0 * t_thump).astype(np.float32) * 0.4
        )

    y /= max(1.0, np.max(np.abs(y)) * 1.05)
    return y


def test_pipeline_on_synthetic_click_track():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        audio_path = td_path / "click.wav"
        y = _synth_click_track(duration=8.0, bpm=120.0)
        sf.write(str(audio_path), y, 22050)

        # Force-skip cache by pointing at a scratch dir
        from backend.app.config import settings

        old_cache = settings.cache_dir
        settings.cache_dir = td_path / "cache"
        try:
            bundle = analyze_audio(audio_path, use_stems=False, force=True)
        finally:
            settings.cache_dir = old_cache

        # Tempo should be ~120 BPM ±3%
        assert 115.0 < bundle.tempo_bpm < 125.0, f"tempo was {bundle.tempo_bpm}"

        # Should find ~16 beats over 8s @ 120 BPM
        assert 14 <= len(bundle.beat_times) <= 18, f"beat count was {len(bundle.beat_times)}"

        # Downbeats (every 4 beats) should be roughly len(beats)/4
        assert len(bundle.downbeat_times) >= 3

        # Required continuous keys
        for name in ("rms", "bass_energy", "spectral_centroid", "spectral_flux"):
            arr = bundle.continuous.get(name)
            assert arr is not None and arr.size > 0, f"missing {name}"
            assert 0.0 <= float(arr.min()) and float(arr.max()) <= 1.0, f"{name} not in [0,1]"

        # Event keys
        for key in ("beat", "downbeat", "drop_detected"):
            assert key in bundle.events, f"missing event {key}"

        # Round-trip the bundle to disk
        save_dir = td_path / "roundtrip"
        bundle.to_disk(save_dir)
        from backend.app.audio.signals import SignalBundle

        reloaded = SignalBundle.from_disk(save_dir)
        assert abs(reloaded.tempo_bpm - bundle.tempo_bpm) < 0.01
        assert len(reloaded.beat_times) == len(bundle.beat_times)


