"""Arranger tests using a synthetic SignalBundle and fake clips."""
from __future__ import annotations

import numpy as np

from backend.app.audio.signals import Section, SignalBundle
from backend.app.project.models import Clip
from backend.app.video.arranger import ArrangerConfig, arrange


def _fake_bundle(duration: float = 16.0, bpm: float = 120.0) -> SignalBundle:
    rate_hz = 100.0
    beat_period = 60.0 / bpm
    n_beats = int(duration / beat_period)
    beats = [i * beat_period for i in range(n_beats)]
    downbeats = [beats[i] for i in range(0, n_beats, 4)]

    rms = np.linspace(0.2, 0.9, int(duration * rate_hz)).astype(np.float32)

    bundle = SignalBundle(
        duration=duration,
        sr=22050,
        rate_hz=rate_hz,
        tempo_bpm=bpm,
        continuous={"rms": rms, "spectral_flux": rms},
        events={"beat": beats, "downbeat": downbeats},
        beat_times=beats,
        downbeat_times=downbeats,
    )
    bundle.sections = [
        Section(start=0.0, end=duration / 2, label="A", energy=0.3),
        Section(start=duration / 2, end=duration, label="B", energy=0.9),
    ]
    return bundle


def _fake_clips() -> list[Clip]:
    return [
        Clip(id="low", filename="low.mp4", path="/tmp/low.mp4", duration=10.0, motion_energy=0.1),
        Clip(id="mid", filename="mid.mp4", path="/tmp/mid.mp4", duration=10.0, motion_energy=0.5),
        Clip(id="hi", filename="hi.mp4", path="/tmp/hi.mp4", duration=10.0, motion_energy=0.95),
    ]


def test_arranger_produces_cuts():
    bundle = _fake_bundle()
    clips = _fake_clips()
    cfg = ArrangerConfig(fps=30.0)
    edl = arrange(bundle, clips, cfg)

    assert len(edl.cuts) > 0
    # All cuts within song duration
    for c in edl.cuts:
        assert 0.0 <= c.t_start < bundle.duration
        assert c.t_end > c.t_start
    # Monotonic start times
    starts = [c.t_start for c in edl.cuts]
    assert starts == sorted(starts)


def test_arranger_matches_high_energy_clips_to_high_energy_sections():
    bundle = _fake_bundle()
    clips = _fake_clips()
    edl = arrange(bundle, clips, ArrangerConfig(fps=30.0))

    first_half = [c for c in edl.cuts if c.t_start < bundle.duration / 2]
    second_half = [c for c in edl.cuts if c.t_start >= bundle.duration / 2]
    assert first_half and second_half

    def hi_ratio(cuts: list) -> float:
        if not cuts:
            return 0.0
        return sum(1 for c in cuts if c.clip_id == "hi") / len(cuts)

    # High-energy section should use the hi clip more often than the low-energy section.
    assert hi_ratio(second_half) > hi_ratio(first_half)


def test_arranger_anti_repetition_window():
    bundle = _fake_bundle()
    clips = _fake_clips()
    edl = arrange(bundle, clips, ArrangerConfig(fps=30.0, anti_repeat_window=3, anti_repeat_penalty=0.8))

    # No clip should repeat 3x in a row
    for i in range(len(edl.cuts) - 2):
        window = [edl.cuts[i].clip_id, edl.cuts[i + 1].clip_id, edl.cuts[i + 2].clip_id]
        assert len(set(window)) > 1, f"3 in a row at {i}"
