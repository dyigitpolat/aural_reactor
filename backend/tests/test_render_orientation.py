"""Regression test for the upside-down render bug.

Synthesizes a clip whose top half is red and bottom half is blue, renders
it through a passthrough effect chain, and asserts that the output MP4 has
red at the top and blue at the bottom.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import av
import numpy as np
import soundfile as sf

from backend.app.project.models import Clip, Cut, EffectChainEntry
from backend.app.render.pipeline import render_project


def _synth_audio(path: Path, duration: float = 2.0) -> None:
    sr = 22050
    t = np.arange(int(sr * duration)) / sr
    y = (0.3 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
    sf.write(str(path), y, sr)


def _synth_bichromatic_clip(path: Path, width: int, height: int, duration: float = 2.0) -> None:
    """Red top half, blue bottom half, solid for `duration` seconds."""
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"color=c=red:s={width}x{height // 2}:d={duration}:r=30",
        "-f", "lavfi",
        "-i", f"color=c=blue:s={width}x{height // 2}:d={duration}:r=30",
        "-filter_complex", "[0:v][1:v]vstack=inputs=2[v]",
        "-map", "[v]",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-t", str(duration),
        str(path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _first_frame(path: Path) -> np.ndarray:
    container = av.open(str(path))
    try:
        stream = next(s for s in container.streams if s.type == "video")
        for frame in container.decode(stream):
            return frame.to_ndarray(format="rgb24")
        raise RuntimeError("no frames")
    finally:
        container.close()


def test_render_preserves_orientation():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        audio = tdp / "song.wav"
        clip_src = tdp / "clip.mp4"
        _synth_audio(audio, 2.0)
        _synth_bichromatic_clip(clip_src, 320, 240, 2.0)

        clip = Clip(
            id="c1", filename="clip.mp4", path=str(clip_src),
            duration=2.0, width=320, height=240, fps=30.0, motion_energy=0.1,
        )
        edl = [Cut(t_start=0.0, t_end=2.0, clip_id="c1", in_point=0.0, speed=1.0, locked=False)]
        # Passthrough-ish chain: vignette at 0 with exposure 0 is a near-identity pass.
        chain = [EffectChainEntry(name="vignette", enabled=True, base_params={"intensity": 0.0, "exposure": 0.0})]

        out = tdp / "out.mp4"
        render_project(
            audio_path=audio, edl=edl, clips=[clip], effect_chain=chain,
            baked=None, out_path=out,
            width=320, height=240, fps=30.0,
        )

        assert out.exists()
        frame = _first_frame(out)
        h, w, _ = frame.shape

        # Sample strongly inside each half to avoid the boundary.
        top = frame[h // 6, w // 2]
        bottom = frame[h - h // 6, w // 2]

        assert top[0] > 180 and top[2] < 60, f"top row not red: {top}"
        assert bottom[2] > 180 and bottom[0] < 60, f"bottom row not blue: {bottom}"
