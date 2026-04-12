"""End-to-end render test.

Synthesizes a short audio clip + a short test video, runs the full pipeline
(analyze → arrange → render), and asserts the output MP4 exists with
reasonable duration + a valid video stream.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.app.audio.pipeline import analyze_audio
from backend.app.project.models import EffectChainEntry, Patch
from backend.app.render.pipeline import render_project
from backend.app.routing.matrix import bake
from backend.app.video.arranger import ArrangerConfig, arrange


def _synth_audio(path: Path, duration: float, bpm: float) -> None:
    sr = 22050
    n = int(sr * duration)
    y = np.zeros(n, dtype=np.float32)
    period = 60.0 / bpm
    beats = int(duration / period)
    for i in range(beats):
        idx = int(i * period * sr)
        if idx + 200 >= n:
            break
        click_len = int(0.005 * sr)
        y[idx : idx + click_len] += np.random.default_rng(i).normal(0, 0.5, click_len).astype(np.float32)
        thump = int(0.08 * sr)
        t = np.arange(thump) / sr
        y[idx : idx + thump] += (
            np.exp(-t * 30.0) * np.sin(2 * np.pi * 55.0 * t) * 0.4
        ).astype(np.float32)
    y /= max(1.0, np.abs(y).max() * 1.05)
    sf.write(str(path), y, sr)


def _synth_video(path: Path, duration: float, color: str) -> None:
    """Generate a solid-color test video via ffmpeg."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"color=c={color}:s=320x180:d={duration}:r=30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-t", str(duration),
        str(path),
    ]
    subprocess.run(cmd, check=True)


def test_full_render_pipeline():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)

        # 1. Make inputs
        audio_path = tdp / "song.wav"
        _synth_audio(audio_path, duration=4.0, bpm=120.0)

        clip_red = tdp / "red.mp4"
        clip_blue = tdp / "blue.mp4"
        _synth_video(clip_red, duration=2.0, color="red")
        _synth_video(clip_blue, duration=2.0, color="blue")

        # 2. Analyze audio
        from backend.app.config import settings as _settings
        orig = _settings.cache_dir
        _settings.cache_dir = tdp / "cache"
        try:
            bundle = analyze_audio(audio_path, use_stems=False, force=True)
        finally:
            _settings.cache_dir = orig

        assert bundle.duration >= 3.5
        assert len(bundle.beat_times) >= 6

        # 3. Build clips + EDL
        from backend.app.project.models import Clip
        clips = [
            Clip(id="red", filename="red.mp4", path=str(clip_red),
                 duration=2.0, width=320, height=180, fps=30.0, motion_energy=0.2),
            Clip(id="blu", filename="blue.mp4", path=str(clip_blue),
                 duration=2.0, width=320, height=180, fps=30.0, motion_energy=0.8),
        ]
        edl = arrange(bundle, clips, ArrangerConfig(fps=30.0))
        assert len(edl.cuts) > 0

        # 4. Bake a simple patch + chain
        patches = [
            Patch(
                id="p1", source="beat", target="zoom.intensity",
                smooth_ms=20.0, latch_ms=80.0, scale_max=0.5, curve="exp",
            ),
        ]
        baked = bake(bundle, patches)
        assert "zoom.intensity" in baked.targets

        chain = [
            EffectChainEntry(name="zoom", enabled=True, base_params={}),
            EffectChainEntry(name="vignette", enabled=True,
                             base_params={"intensity": 0.3, "exposure": 0.0}),
        ]

        # 5. Render
        out_path = tdp / "out.mp4"
        render_project(
            audio_path=audio_path,
            edl=edl.cuts,
            clips=clips,
            effect_chain=chain,
            baked=baked,
            out_path=out_path,
            width=320,
            height=180,
            fps=30.0,
        )

        assert out_path.exists()
        assert out_path.stat().st_size > 5_000, "output too small"

        # 6. ffprobe it
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=codec_type,codec_name,width,height",
                "-show_entries", "format=duration",
                "-of", "default=nw=1",
                str(out_path),
            ],
            check=True, capture_output=True, text=True,
        )
        text = probe.stdout
        assert "codec_type=video" in text
        assert "codec_type=audio" in text
        # Duration should be within 0.5s of the audio duration
        duration_line = [ln for ln in text.splitlines() if ln.startswith("duration=")]
        assert duration_line, text
        dur = float(duration_line[0].split("=")[1])
        assert 3.3 < dur < 4.5, f"unexpected duration {dur}"
