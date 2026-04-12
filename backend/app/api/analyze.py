from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from backend.app.audio.pipeline import analyze_audio, cache_dir_for, file_sha
from backend.app.audio.signals import SignalBundle
from backend.app.config import settings
from backend.app.project.store import store
from backend.app.ws.project_ws import hub

router = APIRouter()
log = logging.getLogger(__name__)


@router.post("/{project_id}")
async def analyze(project_id: str, force: bool = False) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    if project.audio is None:
        raise HTTPException(400, "project has no audio track")

    audio_path = Path(project.audio.path)
    if not audio_path.exists():
        raise HTTPException(400, "audio file missing on disk")

    loop = asyncio.get_running_loop()

    def report(msg: str, frac: float) -> None:
        asyncio.run_coroutine_threadsafe(
            hub.broadcast(project_id, {"type": "analyze_progress", "stage": msg, "frac": frac}),
            loop,
        )

    bpb = project.beats_per_bar

    def _run() -> SignalBundle:
        return analyze_audio(
            audio_path,
            use_stems=settings.enable_stems,
            force=force,
            progress=report,
            beats_per_bar=bpb,
        )

    try:
        bundle = await asyncio.to_thread(_run)
    except Exception as e:
        log.exception("analysis failed")
        await hub.broadcast(project_id, {"type": "analyze_error", "error": str(e)})
        raise HTTPException(500, f"analysis failed: {e}") from e

    project.audio.analyzed = True
    project.audio.duration = bundle.duration
    project.audio.sr = bundle.sr
    store.save(project)

    summary = bundle.summary()
    await hub.broadcast(project_id, {"type": "analyze_done", "summary": summary})
    return {"ok": True, "summary": summary}


@router.get("/{project_id}/summary")
async def get_summary(project_id: str) -> dict:
    project = store.load(project_id)
    if project is None or project.audio is None:
        raise HTTPException(404, "project or audio missing")
    sha = file_sha(Path(project.audio.path))
    cdir = cache_dir_for(sha, use_stems=settings.enable_stems)
    if not cdir.exists():
        raise HTTPException(404, "not analyzed yet")
    bundle = SignalBundle.from_disk(cdir)
    return bundle.summary()


@router.get("/{project_id}/signal/{name}")
async def get_signal(project_id: str, name: str, max_points: int = 2000) -> Response:
    """Return one continuous signal as a binary float32 array for fast UI plotting.

    Downsamples to `max_points` via block-mean so the browser receives
    ~8 KB per 1000 samples instead of raw 30 Hz × song length.
    """
    project = store.load(project_id)
    if project is None or project.audio is None:
        raise HTTPException(404, "project or audio missing")
    sha = file_sha(Path(project.audio.path))
    cdir = cache_dir_for(sha, use_stems=settings.enable_stems)
    if not cdir.exists():
        raise HTTPException(404, "not analyzed yet")

    bundle = SignalBundle.from_disk(cdir)
    arr = bundle.continuous.get(name)
    if arr is None:
        raise HTTPException(404, f"signal '{name}' not found")

    if arr.size > max_points > 0:
        factor = arr.size // max_points
        trimmed = arr[: factor * max_points]
        arr = trimmed.reshape(-1, factor).mean(axis=1).astype(np.float32)

    return Response(
        content=arr.astype(np.float32).tobytes(),
        media_type="application/octet-stream",
        headers={"x-rate-hz": str(bundle.rate_hz), "x-original-rate-hz": str(bundle.rate_hz)},
    )
