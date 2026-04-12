"""Tests for the ClipStrip-supporting API surface:
- PUT /api/projects/{id}/edl
- PATCH /api/projects/{id}/clips/{clip_id}
- GET /api/media/{id}/thumb
- arranger respects Clip.auto_arrange
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
from starlette.testclient import TestClient

from backend.app.audio.signals import SignalBundle
from backend.app.main import app
from backend.app.project.models import Clip
from backend.app.video.arranger import ArrangerConfig, arrange


# ─── Arranger honors Clip.auto_arrange ─────────────────────────────────────


def _fake_bundle(duration: float = 8.0, bpm: float = 120.0) -> SignalBundle:
    rate_hz = 100.0
    beat_period = 60.0 / bpm
    beats = [i * beat_period for i in range(int(duration / beat_period))]
    downbeats = [beats[i] for i in range(0, len(beats), 4)]
    rms = np.linspace(0.2, 0.9, int(duration * rate_hz)).astype(np.float32)
    bundle = SignalBundle(
        duration=duration, sr=22050, rate_hz=rate_hz, tempo_bpm=bpm,
        continuous={"rms": rms, "spectral_flux": rms},
        events={"beat": beats, "downbeat": downbeats},
        beat_times=beats, downbeat_times=downbeats,
    )
    return bundle


def test_arrange_skips_clips_with_auto_arrange_false():
    bundle = _fake_bundle()
    clips = [
        Clip(id="on1", filename="on1.mp4", path="/tmp/on1.mp4",
             duration=10.0, motion_energy=0.3, auto_arrange=True),
        Clip(id="on2", filename="on2.mp4", path="/tmp/on2.mp4",
             duration=10.0, motion_energy=0.7, auto_arrange=True),
        Clip(id="off", filename="off.mp4", path="/tmp/off.mp4",
             duration=10.0, motion_energy=0.5, auto_arrange=False),
    ]
    edl = arrange(bundle, clips, ArrangerConfig(fps=30.0))
    used_ids = {c.clip_id for c in edl.cuts}
    assert "off" not in used_ids, "disabled clip leaked into auto-arrange"
    assert "on1" in used_ids or "on2" in used_ids


def test_arrange_returns_empty_when_all_clips_disabled():
    bundle = _fake_bundle()
    clips = [
        Clip(id="off1", filename="x.mp4", path="/tmp/x.mp4",
             duration=10.0, motion_energy=0.3, auto_arrange=False),
        Clip(id="off2", filename="y.mp4", path="/tmp/y.mp4",
             duration=10.0, motion_energy=0.7, auto_arrange=False),
    ]
    edl = arrange(bundle, clips, ArrangerConfig(fps=30.0))
    assert len(edl.cuts) == 0


# ─── API round-trips ────────────────────────────────────────────────────────


def _client() -> TestClient:
    return TestClient(app)


def _synth_clip_file(path: Path, color: str, duration: float = 2.0) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", f"color=c={color}:s=160x90:d={duration}:r=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-t", str(duration),
            str(path),
        ],
        check=True, capture_output=True,
    )


def test_patch_clip_toggles_auto_arrange():
    with tempfile.TemporaryDirectory() as td:
        c = _client()
        proj = c.post("/api/projects", json={"name": "patch-test"}).json()
        pid = proj["id"]

        clip_path = Path(td) / "c.mp4"
        _synth_clip_file(clip_path, "red")
        with clip_path.open("rb") as f:
            r = c.post(
                f"/api/media/{pid}/clips",
                files={"file": ("red.mp4", f, "video/mp4")},
            )
        assert r.status_code == 200, r.text
        clip_id = r.json()["clip"]["id"]
        assert r.json()["clip"]["auto_arrange"] is True  # default

        r = c.patch(
            f"/api/projects/{pid}/clips/{clip_id}",
            json={"auto_arrange": False},
        )
        assert r.status_code == 200, r.text
        project = r.json()
        assert project["clips"][0]["auto_arrange"] is False

        c.delete(f"/api/projects/{pid}")


def test_put_edl_validates_clip_ids_and_persists():
    with tempfile.TemporaryDirectory() as td:
        c = _client()
        proj = c.post("/api/projects", json={"name": "edl-test"}).json()
        pid = proj["id"]

        clip_path = Path(td) / "c.mp4"
        _synth_clip_file(clip_path, "blue")
        with clip_path.open("rb") as f:
            r = c.post(
                f"/api/media/{pid}/clips",
                files={"file": ("blue.mp4", f, "video/mp4")},
            )
        clip_id = r.json()["clip"]["id"]

        # Valid EDL — two cuts referencing the uploaded clip.
        new_edl = [
            {"t_start": 0.0, "t_end": 1.0, "clip_id": clip_id,
             "in_point": 0.0, "speed": 1.0, "locked": False},
            {"t_start": 1.0, "t_end": 2.0, "clip_id": clip_id,
             "in_point": 0.5, "speed": 1.0, "locked": True},
        ]
        r = c.put(f"/api/projects/{pid}/edl", json={"edl": new_edl})
        assert r.status_code == 200, r.text
        project = r.json()
        assert len(project["edl"]) == 2
        assert project["edl"][1]["locked"] is True

        # Reject unknown clip_id.
        bad = [
            {"t_start": 0.0, "t_end": 1.0, "clip_id": "does_not_exist",
             "in_point": 0.0, "speed": 1.0, "locked": False},
        ]
        r = c.put(f"/api/projects/{pid}/edl", json={"edl": bad})
        assert r.status_code == 400

        # Reject non-positive duration.
        bad2 = [
            {"t_start": 1.0, "t_end": 1.0, "clip_id": clip_id,
             "in_point": 0.0, "speed": 1.0, "locked": False},
        ]
        r = c.put(f"/api/projects/{pid}/edl", json={"edl": bad2})
        assert r.status_code == 400

        c.delete(f"/api/projects/{pid}")


def test_thumbnail_endpoint_returns_jpeg_and_caches():
    with tempfile.TemporaryDirectory() as td:
        c = _client()
        proj = c.post("/api/projects", json={"name": "thumb-test"}).json()
        pid = proj["id"]

        clip_path = Path(td) / "c.mp4"
        _synth_clip_file(clip_path, "green", duration=3.0)
        with clip_path.open("rb") as f:
            r = c.post(
                f"/api/media/{pid}/clips",
                files={"file": ("green.mp4", f, "video/mp4")},
            )
        clip_id = r.json()["clip"]["id"]

        r = c.get(f"/api/media/{pid}/thumb?clip={clip_id}&t=1.0&w=120")
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "image/jpeg"
        assert len(r.content) > 500  # non-trivial jpeg
        # Second call should hit cache (still 200, still jpeg).
        r2 = c.get(f"/api/media/{pid}/thumb?clip={clip_id}&t=1.0&w=120")
        assert r2.status_code == 200

        c.delete(f"/api/projects/{pid}")
