"""Final-render pipeline: EDL + effects + audio → MP4 via ModernGL + ffmpeg."""
from __future__ import annotations

import logging
import queue
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Iterator

import av
import numpy as np

from backend.app.project.models import Clip, Cut, EffectChainEntry
from backend.app.render.gl import EffectChainGL
from backend.app.routing.matrix import BakedModulation

log = logging.getLogger(__name__)


def _probe_videotoolbox() -> bool:
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, check=True,
        ).stdout
        return "h264_videotoolbox" in out
    except Exception:
        return False


HAS_VIDEOTOOLBOX = _probe_videotoolbox()


def _encoder_args() -> list[str]:
    if HAS_VIDEOTOOLBOX:
        return [
            "-c:v", "h264_videotoolbox",
            "-b:v", "15M",
            "-profile:v", "high",
        ]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]


# ---------------------------------------------------------------------------
# Decoder reuse — single PyAV container per clip across all cuts.
# ---------------------------------------------------------------------------


class _ClipDecoder:
    """One PyAV container kept open across cuts that share the same clip.

    `frame_at(t_rel)` returns the latest decoded frame whose pts <= t_rel,
    seeking backward if the request is earlier than the current decode
    position.
    """

    def __init__(self, path: Path):
        self.path = path
        self.container = av.open(str(path))
        self.stream = next(s for s in self.container.streams if s.type == "video")
        self.stream.thread_type = "AUTO"
        self._iter: Iterator[av.VideoFrame] | None = None
        self._current_pts: float | None = None
        self._current_frame: np.ndarray | None = None

    def _restart_iter_at(self, target_t: float) -> None:
        seek_t = max(0.0, target_t - 0.5)
        self.container.seek(
            int(seek_t / self.stream.time_base),
            stream=self.stream,
            any_frame=False,
            backward=True,
        )
        self._iter = self.container.decode(self.stream)
        self._current_pts = None
        self._current_frame = None

    def frame_at(self, target_t: float) -> np.ndarray | None:
        # Backward jump → reseek.
        if self._current_pts is not None and target_t + 0.05 < self._current_pts:
            self._restart_iter_at(target_t)
        if self._iter is None:
            self._restart_iter_at(target_t)

        # Advance forward until current frame's pts >= target_t.
        assert self._iter is not None
        while True:
            if self._current_pts is not None and self._current_pts >= target_t:
                return self._current_frame
            try:
                frame = next(self._iter)
            except StopIteration:
                return self._current_frame
            if frame.pts is None:
                continue
            pts = float(frame.pts * self.stream.time_base)
            self._current_pts = pts
            self._current_frame = frame.to_ndarray(format="rgb24")
            if pts >= target_t:
                return self._current_frame

    def close(self) -> None:
        try:
            self.container.close()
        except Exception:
            pass


class _DecoderCache:
    """Lazy per-clip decoder cache; opens each clip exactly once."""

    def __init__(self) -> None:
        self._decoders: dict[str, _ClipDecoder] = {}

    def get(self, clip_id: str, path: Path) -> _ClipDecoder:
        d = self._decoders.get(clip_id)
        if d is None:
            d = _ClipDecoder(path)
            self._decoders[clip_id] = d
        return d

    def close_all(self) -> None:
        for d in self._decoders.values():
            d.close()
        self._decoders.clear()


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


def render_project(
    audio_path: Path,
    edl: list[Cut],
    clips: list[Clip],
    effect_chain: list[EffectChainEntry],
    baked: BakedModulation | None,
    out_path: Path,
    width: int = 1280,
    height: int = 720,
    fps: float = 30.0,
    progress: Callable[[str, float], None] | None = None,
) -> Path:
    if not edl:
        raise ValueError("empty EDL")

    clip_by_id = {c.id: c for c in clips}
    total_duration = max(c.t_end for c in edl)
    total_frames = int(round(total_duration * fps))

    def report(msg: str, frac: float) -> None:
        log.info("render [%.0f%%] %s", frac * 100, msg)
        if progress is not None:
            try:
                progress(msg, frac)
            except Exception:
                pass

    report("initializing GL", 0.0)
    chain_gl = EffectChainGL(width=width, height=height)
    chain_gl.apply_effect_chain(effect_chain)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_video = out_path.with_suffix(".video.mp4")

    encoder_args = _encoder_args()

    ffmpeg_proc = subprocess.Popen(
        [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo",
            "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}",
            "-r", f"{fps}",
            "-i", "-",
            "-an",
            *encoder_args,
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(tmp_video),
        ],
        stdin=subprocess.PIPE,
    )
    assert ffmpeg_proc.stdin is not None

    cache = _DecoderCache()

    # Producer/consumer pipeline: the decode+cut-lookup runs on its own
    # thread, feeding a small bounded queue. The main thread handles GL upload,
    # render, readback, and ffmpeg stdin write. This overlaps the PyAV work
    # with the GL work — on most machines decode and GL are both 3-5ms/frame
    # so this is roughly a 2x speedup.
    edl_sorted = sorted(edl, key=lambda c: c.t_start)
    frame_queue: queue.Queue = queue.Queue(maxsize=8)
    producer_error: list[BaseException] = []

    def producer() -> None:
        try:
            cut_idx = 0
            current_cut: Cut | None = None
            current_aspect: tuple[int, int] | None = None
            for frame_idx in range(total_frames):
                t = frame_idx / fps
                while cut_idx + 1 < len(edl_sorted) and edl_sorted[cut_idx + 1].t_start <= t:
                    cut_idx += 1
                    current_cut = None
                cut_changed = False
                if current_cut is None or current_cut is not edl_sorted[cut_idx]:
                    current_cut = edl_sorted[cut_idx]
                    cut_changed = True
                    clip = clip_by_id.get(current_cut.clip_id)
                    if clip is not None and clip.width > 0 and clip.height > 0:
                        current_aspect = (clip.width, clip.height)

                rgb: np.ndarray | None = None
                if current_cut is not None:
                    clip = clip_by_id.get(current_cut.clip_id)
                    if clip is not None:
                        decoder = cache.get(clip.id, Path(clip.path))
                        t_rel = current_cut.in_point + (t - current_cut.t_start) * current_cut.speed
                        rgb = decoder.frame_at(t_rel)

                frame_queue.put((
                    frame_idx,
                    t,
                    rgb,
                    current_aspect if cut_changed else None,
                ))
        except BaseException as e:  # noqa: BLE001
            producer_error.append(e)
        finally:
            frame_queue.put(None)  # sentinel

    producer_thread = threading.Thread(target=producer, daemon=True)
    producer_thread.start()

    try:
        report(
            f"rendering {total_frames} frames at {width}x{height}@{fps}fps "
            f"({'hw' if HAS_VIDEOTOOLBOX else 'cpu'})",
            0.02,
        )
        last_frame_bytes: bytes | None = None
        black = np.zeros((height, width, 3), dtype=np.uint8).tobytes()

        while True:
            item = frame_queue.get()
            if item is None:
                break
            frame_idx, t, rgb, aspect_change = item

            if aspect_change is not None:
                chain_gl.set_clip_aspect(*aspect_change)

            if rgb is not None:
                chain_gl.upload_frame(rgb)
                out_rgb = chain_gl.render_frame(t, baked=baked)
                last_frame_bytes = out_rgb.tobytes()

            buf = last_frame_bytes if last_frame_bytes is not None else black
            ffmpeg_proc.stdin.write(buf)

            if frame_idx % max(1, total_frames // 40) == 0:
                report(
                    f"frame {frame_idx}/{total_frames}",
                    0.05 + 0.85 * (frame_idx / max(1, total_frames)),
                )

        producer_thread.join(timeout=5.0)
        if producer_error:
            raise producer_error[0]

        ffmpeg_proc.stdin.close()
        rc = ffmpeg_proc.wait()
        if rc != 0:
            raise RuntimeError(f"ffmpeg video encode failed with code {rc}")
    finally:
        if ffmpeg_proc.stdin and not ffmpeg_proc.stdin.closed:
            ffmpeg_proc.stdin.close()
        chain_gl.release()
        cache.close_all()

    report("muxing audio", 0.92)
    audio_encoder = ["-c:a", "aac", "-b:a", "192k"]
    mux_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(tmp_video),
        "-i", str(audio_path),
        "-c:v", "copy",
        *audio_encoder,
        "-shortest",
        "-movflags", "+faststart",
        str(out_path),
    ]
    rc = subprocess.run(mux_cmd, check=False).returncode
    if rc != 0:
        raise RuntimeError(f"ffmpeg mux failed with code {rc}")

    try:
        tmp_video.unlink()
    except FileNotFoundError:
        pass

    report("done", 1.0)
    return out_path
