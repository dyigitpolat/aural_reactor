"""Clip metadata + motion-energy scoring (PyAV + numpy, no OpenCV).

We intentionally avoid `import cv2` here because on macOS, importing cv2
loads its bundled libavdevice, which collides with PyAV's bundled libavdevice
and produces `objc[]: Class AVFFrameReceiver is implemented in both` warnings.
Since this module is imported at server startup, that warning would show up
every run. Using PyAV + Pillow keeps us on a single ffmpeg stack.

Motion energy is approximated by mean absolute frame difference at a
downsampled resolution. This is ~20x faster than Farneback optical flow and
a perfectly adequate "how much is going on in this clip" score for clip
scheduling — we just need a relative ordering of clips by activity.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import av
import numpy as np
from PIL import Image

log = logging.getLogger(__name__)


@dataclass
class ClipProbe:
    duration: float
    width: int
    height: int
    fps: float
    motion_energy: float


def probe_metadata(path: Path) -> dict:
    container = av.open(str(path))
    try:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            raise ValueError(f"no video stream in {path}")
        fps = float(stream.average_rate) if stream.average_rate else 0.0
        duration = float(stream.duration * stream.time_base) if stream.duration else 0.0
        if duration == 0.0 and container.duration:
            duration = container.duration / av.time_base
        return {
            "duration": duration,
            "width": stream.codec_context.width,
            "height": stream.codec_context.height,
            "fps": fps,
        }
    finally:
        container.close()


def probe_with_motion(path: Path, sample_fps: float = 4.0, max_side: int = 160) -> ClipProbe:
    meta = probe_metadata(path)
    motion = probe_motion_energy(path, sample_fps=sample_fps, max_side=max_side)
    return ClipProbe(
        duration=meta["duration"],
        width=meta["width"],
        height=meta["height"],
        fps=meta["fps"],
        motion_energy=motion,
    )


def probe_motion_energy(
    path: Path,
    sample_fps: float = 4.0,
    max_side: int = 160,
    max_scan_seconds: float = 8.0,
) -> float:
    """Return a [0, 1] "motion energy" score based on frame differencing."""
    container = av.open(str(path))
    try:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            return 0.0
        stream.thread_type = "AUTO"

        native_fps = float(stream.average_rate) if stream.average_rate else 30.0
        frame_stride = max(1, int(round(native_fps / max(0.1, sample_fps))))
        frame_cap = int(sample_fps * max_scan_seconds) + 1

        prev_gray: np.ndarray | None = None
        diffs: list[float] = []
        idx = 0

        for frame in container.decode(stream):
            if idx % frame_stride != 0:
                idx += 1
                continue
            idx += 1

            rgb = frame.to_ndarray(format="rgb24")
            h, w = rgb.shape[:2]
            scale = max_side / max(h, w)
            if scale < 1.0:
                new_w = max(1, int(w * scale))
                new_h = max(1, int(h * scale))
                img = Image.fromarray(rgb)
                img = img.resize((new_w, new_h), Image.Resampling.BILINEAR)
                rgb = np.asarray(img)

            gray = rgb.astype(np.float32).mean(axis=2)  # simple luma average
            if prev_gray is not None:
                diff = np.abs(gray - prev_gray)
                diffs.append(float(diff.mean()))
            prev_gray = gray

            if len(diffs) >= frame_cap:
                break
    finally:
        container.close()

    if not diffs:
        return 0.0
    raw = float(np.mean(diffs))
    # Heuristic normalization: ~0..25 mean-abs-diff on 0..255 grayscale maps to 0..1.
    return float(max(0.0, min(1.0, raw / 25.0)))
