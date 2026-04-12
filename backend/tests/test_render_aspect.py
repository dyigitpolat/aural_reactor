"""Center-crop aspect test — a portrait clip rendered into a landscape project
should produce a horizontally-dominated crop (not a stretched portrait).
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
    y = (0.3 * np.sin(2 * np.pi * 330.0 * t)).astype(np.float32)
    sf.write(str(path), y, sr)


def _synth_striped_clip(
    path: Path, width: int, height: int, duration: float = 2.0
) -> None:
    """Source with 3 vertical bands: left=red, middle=green, right=blue."""
    third = width // 3
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"color=c=red:s={third}x{height}:d={duration}:r=30",
        "-f", "lavfi",
        "-i", f"color=c=lime:s={third}x{height}:d={duration}:r=30",
        "-f", "lavfi",
        "-i", f"color=c=blue:s={width - 2 * third}x{height}:d={duration}:r=30",
        "-filter_complex", "[0:v][1:v][2:v]hstack=inputs=3[v]",
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


def _render(audio: Path, clip_path: Path, clip_w: int, clip_h: int, out_w: int, out_h: int, out: Path) -> None:
    clip = Clip(
        id="c1", filename=clip_path.name, path=str(clip_path),
        duration=2.0, width=clip_w, height=clip_h, fps=30.0, motion_energy=0.1,
    )
    edl = [Cut(t_start=0.0, t_end=2.0, clip_id="c1", in_point=0.0, speed=1.0, locked=False)]
    chain = [EffectChainEntry(name="vignette", enabled=True, base_params={"intensity": 0.0, "exposure": 0.0})]
    render_project(
        audio_path=audio, edl=edl, clips=[clip], effect_chain=chain,
        baked=None, out_path=out,
        width=out_w, height=out_h, fps=30.0,
    )


def test_portrait_source_into_landscape_output_is_centered_not_stretched():
    """
    Portrait 360×640 source (vertical stripes R/G/B) rendered into 640×360.

    With center-crop, the source's vertical bands should still be vertical in
    the output — the 3 stripes should span the full width of the output (the
    source fills output.x entirely since source is narrower than output in
    relative terms). And crucially, the middle column must be green, not a
    vertically-stretched blur.

    Since source width (360) maps 1:1 to output.x, the green middle band
    (source x: 120..240, i.e. uv.x 0.333..0.667) lands at output x 213..426.
    Center column (320) is well inside → must be green.
    """
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        audio = tdp / "song.wav"
        clip = tdp / "portrait.mp4"
        _synth_audio(audio, 2.0)
        _synth_striped_clip(clip, width=360, height=640)

        out = tdp / "out.mp4"
        _render(audio, clip, clip_w=360, clip_h=640, out_w=640, out_h=360, out=out)

        frame = _first_frame(out)
        h, w, _ = frame.shape

        # Sample middle row (row h/2), at left/center/right columns.
        row = frame[h // 2]
        left = row[w // 6]
        center = row[w // 2]
        right = row[w - w // 6]

        assert left[0] > 180 and left[1] < 80, f"left should be red: {left}"
        assert center[1] > 180 and center[0] < 80, f"center should be green: {center}"
        assert right[2] > 180 and right[1] < 80, f"right should be blue: {right}"


def test_landscape_source_into_portrait_output_is_cropped_not_squeezed():
    """
    Landscape 640×360 source (horizontal band test) rendered into 360×640.

    With center-crop (source is much wider than portrait output), the output
    samples uv.x only from a narrow band around 0.5 — specifically scale_x =
    outputAspect / clipAspect = (360/640) / (640/360) = 0.316. So output sees
    source uv.x ∈ [0.342, 0.658].

    Our 3-stripe source has green at uv.x ∈ [0.333, 0.667], which exactly
    covers that range → the output should be essentially all green.
    """
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        audio = tdp / "song.wav"
        clip = tdp / "landscape.mp4"
        _synth_audio(audio, 2.0)
        _synth_striped_clip(clip, width=640, height=360)

        out = tdp / "out.mp4"
        _render(audio, clip, clip_w=640, clip_h=360, out_w=360, out_h=640, out=out)

        frame = _first_frame(out)
        # Sample a few points — all should be green-dominant.
        for y, x in [(100, 180), (320, 100), (320, 180), (320, 260), (500, 180)]:
            px = frame[y, x]
            assert px[1] > 150 and px[0] < 100 and px[2] < 100, (
                f"pixel ({y},{x}) should be green, got {px}"
            )
