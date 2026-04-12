"""Ingest + probe tests for the exotic-format upload path.

We use ffmpeg's lavfi to synthesize source media in odd containers/codecs on
the fly, then run ingest_audio/ingest_video and assert the canonical outputs.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import av
import pytest

from backend.app.media.ingest import IngestError, ingest_audio, ingest_video
from backend.app.video.probe import probe_motion_energy, probe_with_motion


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def _synth_audio(out: Path, codec: str = "libmp3lame", container_ext: str = ".mp3", duration: float = 2.0) -> None:
    out = out.with_suffix(container_ext)
    _run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={duration}",
            "-c:a", codec,
            str(out),
        ]
    )


def _synth_video(out: Path, codec: str = "libx264", container_ext: str = ".mp4", duration: float = 1.5, color: str = "blue") -> Path:
    out = out.with_suffix(container_ext)
    _run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", f"color=c={color}:s=320x240:d={duration}:r=30",
            "-f", "lavfi",
            "-i", f"sine=frequency=220:duration={duration}",
            "-c:v", codec,
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-shortest",
            str(out),
        ]
    )
    return out


def test_ingest_audio_mp3():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        src = tdp / "in.mp3"
        _synth_audio(src, "libmp3lame", ".mp3", duration=2.0)
        out = tdp / "canonical"
        info = ingest_audio(src, out)
        assert info.path.suffix == ".flac"
        assert info.path.exists()
        assert info.sample_rate == 48000
        assert 1.8 < info.duration < 2.2
        assert info.codec == "mp3"


def test_ingest_audio_webm_opus():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        src = tdp / "in.webm"
        _run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "sine=frequency=330:duration=1.5",
                "-c:a", "libopus",
                str(src),
            ]
        )
        out = tdp / "canonical"
        info = ingest_audio(src, out)
        assert info.path.suffix == ".flac"
        assert info.sample_rate == 48000


def test_ingest_audio_corrupt_raises_cleanly():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        junk = tdp / "not_audio.mp3"
        junk.write_bytes(b"<html><body>this is not audio</body></html>")
        out = tdp / "canonical"
        with pytest.raises(IngestError):
            ingest_audio(junk, out)


def test_ingest_video_m4v_remuxes():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        src = _synth_video(tdp / "in", container_ext=".m4v")
        out = tdp / "clips" / "abc"
        info = ingest_video(src, out)
        assert info.path.suffix == ".mp4"
        assert info.path.exists()
        assert info.width == 320 and info.height == 240
        assert 1.4 < info.duration < 1.7
        # h264+aac+m4v → can copy without re-encode
        assert info.transcoded is False


def test_ingest_video_mkv_transcodes():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        src = _synth_video(tdp / "in", container_ext=".mkv")
        out = tdp / "clips" / "abc"
        info = ingest_video(src, out)
        assert info.path.suffix == ".mp4"
        # mkv is not in the compat container set → transcoded (or at least re-muxed)
        assert info.path.exists()
        # Verify the output is H.264 yuv420p so browsers can play it.
        container = av.open(str(info.path))
        try:
            v = next(s for s in container.streams if s.type == "video")
            assert v.codec_context.name == "h264"
        finally:
            container.close()


def test_ingest_video_no_audio_track():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        src = tdp / "silent.mp4"
        _run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "color=c=red:s=160x90:d=1:r=30",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-an",
                str(src),
            ]
        )
        out = tdp / "clips" / "xyz"
        info = ingest_video(src, out)
        assert info.path.exists()
        assert info.has_audio is False


def test_probe_motion_energy_via_pyav_only():
    """Ensures probe_motion_energy works without importing cv2."""
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        still = tdp / "still.mp4"
        moving = tdp / "moving.mp4"
        _run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "color=c=blue:s=160x90:d=2:r=30",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                str(still),
            ]
        )
        _run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", "testsrc=s=160x90:d=2:r=30",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                str(moving),
            ]
        )
        still_score = probe_motion_energy(still)
        moving_score = probe_motion_energy(moving)
        assert still_score < 0.05, f"still clip had motion {still_score}"
        assert moving_score > still_score, f"testsrc should move more than still: {moving_score} vs {still_score}"


def test_probe_with_motion_full():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        src = _synth_video(tdp / "clip", container_ext=".mp4", duration=2.0)
        probe = probe_with_motion(src)
        assert probe.width == 320 and probe.height == 240
        assert probe.fps > 0
        assert probe.duration > 1.8
