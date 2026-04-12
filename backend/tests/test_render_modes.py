"""Preview and Export render modes emit MP4s at the expected resolutions."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.app.project.models import Clip, Cut, EffectChainEntry
from backend.app.render.pipeline import render_project


def _synth_audio(path: Path, duration: float = 3.0) -> None:
    sr = 22050
    t = np.arange(int(sr * duration)) / sr
    y = (0.3 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
    sf.write(str(path), y, sr)


def _synth_clip(path: Path, color: str, width: int, height: int, duration: float = 3.0) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", f"color=c={color}:s={width}x{height}:d={duration}:r=30",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-t", str(duration),
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _probe_dims(path: Path) -> tuple[int, int, float]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip().splitlines()
    return int(out[0]), int(out[1]), float(out[2])


def test_export_render_basic():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        audio = tdp / "song.wav"
        clip_a = tdp / "red.mp4"
        clip_b = tdp / "blue.mp4"
        _synth_audio(audio, 3.0)
        _synth_clip(clip_a, "red", 320, 180)
        _synth_clip(clip_b, "blue", 320, 180)

        clips = [
            Clip(id="r", filename="red.mp4", path=str(clip_a),
                 duration=3.0, width=320, height=180, fps=30.0, motion_energy=0.2),
            Clip(id="b", filename="blue.mp4", path=str(clip_b),
                 duration=3.0, width=320, height=180, fps=30.0, motion_energy=0.8),
        ]
        edl = [
            Cut(t_start=0.0, t_end=1.5, clip_id="r", in_point=0.0, speed=1.0, locked=False),
            Cut(t_start=1.5, t_end=3.0, clip_id="b", in_point=0.0, speed=1.0, locked=False),
        ]
        chain = [EffectChainEntry(name="vignette", enabled=True, base_params={"intensity": 0.0, "exposure": 0.0})]

        export_out = tdp / "export.mp4"

        render_project(
            audio_path=audio, edl=edl, clips=clips, effect_chain=chain,
            baked=None, out_path=export_out,
            width=640, height=360, fps=30.0,
        )

        ew, eh, edur = _probe_dims(export_out)

        assert (ew, eh) == (640, 360)
        assert 2.8 < edur < 3.3
        assert export_out.stat().st_size > 0
