"""Media ingest — normalize arbitrary uploads to a canonical internal format.

Goals:
  - Accept any format ffmpeg can read (mp3, m4a, flac, wav, aac, ogg, opus,
    mkv, mp4, mov, m4v, webm, avi, mts, ...).
  - Produce a single canonical file that is valid for both:
      1. browser playback (HTMLAudioElement / HTMLVideoElement)
      2. server-side analysis (librosa / PyAV / ModernGL render pipeline)
  - Skip the re-encode when the source is already in a compatible codec.

Canonical outputs:
  - audio: FLAC at 48 kHz stereo — lossless, browser-playable, librosa-safe.
  - video: H.264 yuv420p MP4 + AAC audio, faststart — the universal web target.

Uses ffprobe/ffmpeg as subprocess calls. No Python-side codec work.
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


class IngestError(RuntimeError):
    pass


@dataclass
class AudioIngest:
    path: Path
    duration: float
    sample_rate: int
    channels: int
    codec: str
    transcoded: bool


@dataclass
class VideoIngest:
    path: Path
    duration: float
    width: int
    height: int
    fps: float
    codec: str
    has_audio: bool
    transcoded: bool


def _run(cmd: list[str], desc: str, capture: bool = True) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            cmd,
            check=True,
            capture_output=capture,
            text=capture,
        )
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip() if capture else "<not captured>"
        raise IngestError(f"{desc} failed: {stderr}") from e
    return proc


def _ffprobe(path: Path) -> dict:
    """Return ffprobe's JSON output for a media file."""
    proc = _run(
        [
            "ffprobe", "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        desc="ffprobe",
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise IngestError(f"ffprobe returned invalid json: {e}") from e


def _first_stream(info: dict, stream_type: str) -> dict | None:
    for s in info.get("streams", []):
        if s.get("codec_type") == stream_type:
            return s
    return None


def _parse_fps(rate_str: str | None) -> float:
    if not rate_str:
        return 0.0
    try:
        if "/" in rate_str:
            num, den = rate_str.split("/", 1)
            d = float(den)
            return float(num) / d if d > 0 else 0.0
        return float(rate_str)
    except ValueError:
        return 0.0


# ---- audio --------------------------------------------------------------


def ingest_audio(src_path: Path, out_path: Path) -> AudioIngest:
    """Normalize an audio file to `out_path` (extension ignored, .flac is appended).

    If the source is already a clean FLAC with a sensible SR, we still re-encode
    through ffmpeg. The cost of ~1s of ffmpeg work per upload is worth the
    guarantee that librosa never sees a corrupted or junk-headered file.
    """
    out_path = out_path.with_suffix(".flac")

    # Quick sanity probe first — this is what catches "file is 400 KB of HTML".
    info = _ffprobe(src_path)
    a = _first_stream(info, "audio")
    if a is None:
        raise IngestError("no audio stream in uploaded file")

    codec = a.get("codec_name", "")
    original_sr = int(a.get("sample_rate", 0) or 0)
    original_channels = int(a.get("channels", 2) or 2)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "error",
            "-i", str(src_path),
            "-vn",
            "-ac", "2",
            "-ar", "48000",
            "-c:a", "flac",
            "-compression_level", "5",
            str(out_path),
        ],
        desc="audio transcode",
    )

    info2 = _ffprobe(out_path)
    a2 = _first_stream(info2, "audio")
    fmt = info2.get("format", {})
    duration = float(fmt.get("duration", 0.0) or 0.0)

    return AudioIngest(
        path=out_path,
        duration=duration,
        sample_rate=int((a2 or {}).get("sample_rate", 48000)),
        channels=int((a2 or {}).get("channels", 2)),
        codec=codec,
        transcoded=True,
    )


# ---- video --------------------------------------------------------------


# Codecs already safe for both PyAV decode and browser <video> playback.
_COMPAT_VIDEO_CODECS = {"h264", "hevc"}
_COMPAT_AUDIO_CODECS = {"aac", "mp3", "opus"}
_COMPAT_CONTAINER_EXTS = {".mp4", ".m4v", ".mov"}


def ingest_video(src_path: Path, out_path: Path) -> VideoIngest:
    """Normalize a video file to `out_path` (will be .mp4).

    Strategy:
      - ffprobe the source.
      - If video codec is h264/hevc, audio is aac/mp3/opus, and container is
        mp4/mov, stream-copy to .mp4 (milliseconds, no re-encode).
      - Otherwise, transcode video to H.264 yuv420p + AAC audio.
    """
    out_path = out_path.with_suffix(".mp4")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    info = _ffprobe(src_path)
    v = _first_stream(info, "video")
    if v is None:
        raise IngestError("no video stream in uploaded file")
    a = _first_stream(info, "audio")

    v_codec = v.get("codec_name", "")
    a_codec = (a or {}).get("codec_name", "") if a else ""
    ext = src_path.suffix.lower()
    pix_fmt = v.get("pix_fmt", "")
    is_web_pix_fmt = pix_fmt in ("yuv420p", "yuvj420p")

    width = int(v.get("width", 0) or 0)
    height = int(v.get("height", 0) or 0)
    fps = _parse_fps(v.get("avg_frame_rate") or v.get("r_frame_rate"))
    fmt = info.get("format", {})
    duration = float(fmt.get("duration", 0.0) or 0.0)

    can_copy = (
        v_codec in _COMPAT_VIDEO_CODECS
        and is_web_pix_fmt
        and (a is None or a_codec in _COMPAT_AUDIO_CODECS)
        and ext in _COMPAT_CONTAINER_EXTS
    )

    if can_copy:
        _run(
            [
                "ffmpeg", "-y",
                "-hide_banner", "-loglevel", "error",
                "-i", str(src_path),
                "-c", "copy",
                "-movflags", "+faststart",
                str(out_path),
            ],
            desc="video remux",
        )
        transcoded = False
    else:
        cmd = [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "error",
            "-i", str(src_path),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ]
        if a is not None:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")
        cmd.append(str(out_path))
        _run(cmd, desc="video transcode")
        transcoded = True

    # Re-probe the output so downstream sees authoritative values.
    info2 = _ffprobe(out_path)
    v2 = _first_stream(info2, "video") or {}
    fmt2 = info2.get("format", {})

    return VideoIngest(
        path=out_path,
        duration=float(fmt2.get("duration", duration) or duration),
        width=int(v2.get("width", width) or width),
        height=int(v2.get("height", height) or height),
        fps=_parse_fps(v2.get("avg_frame_rate") or v2.get("r_frame_rate")) or fps,
        codec=v_codec,
        has_audio=a is not None,
        transcoded=transcoded,
    )
