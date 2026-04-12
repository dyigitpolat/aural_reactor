from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.app.audio.pipeline import cache_dir_for, file_sha
from backend.app.audio.signals import SignalBundle
from backend.app.config import settings
from backend.app.project.store import store
from backend.app.render.pipeline import render_project
from backend.app.routing.matrix import bake
from backend.app.ws.project_ws import hub

router = APIRouter()
log = logging.getLogger(__name__)


class RenderRequest(BaseModel):
    width: int | None = None
    height: int | None = None


def _resolve_dimensions(project_w: int, project_h: int, req: RenderRequest) -> tuple[int, int]:
    w = req.width or project_w or 1920
    h = req.height or project_h or 1080
    # Round to even (required by H.264).
    w -= w % 2
    h -= h % 2
    return w, h


@router.post("/{project_id}/export")
async def render_export(project_id: str, req: RenderRequest | None = None) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    if project.audio is None:
        raise HTTPException(400, "project has no audio")
    if not project.edl:
        raise HTTPException(400, "project has no EDL — click Arrange first")

    sha = file_sha(Path(project.audio.path))
    cdir = cache_dir_for(sha, use_stems=settings.enable_stems)
    if not cdir.exists():
        raise HTTPException(400, "audio not analyzed yet")

    width, height = _resolve_dimensions(project.width, project.height, req or RenderRequest())
    fps = project.fps

    loop = asyncio.get_running_loop()

    def report(msg: str, frac: float) -> None:
        asyncio.run_coroutine_threadsafe(
            hub.broadcast(
                project_id,
                {"type": "render_progress", "stage": msg, "frac": frac},
            ),
            loop,
        )

    run_id = uuid.uuid4().hex[:10]
    out_path = settings.renders_dir / project_id / f"{run_id}_export.mp4"

    def _run() -> Path:
        t0 = time.time()
        bundle = SignalBundle.from_disk(cdir)
        baked = bake(bundle, project.patches)
        result = render_project(
            audio_path=Path(project.audio.path),
            edl=project.edl,
            clips=project.clips,
            effect_chain=project.effect_chain,
            baked=baked,
            out_path=out_path,
            width=width,
            height=height,
            fps=fps,
            progress=report,
        )
        log.info("export render complete in %.1fs -> %s", time.time() - t0, result)
        return result

    try:
        result_path = await asyncio.to_thread(_run)
    except Exception as e:
        log.exception("render failed")
        await hub.broadcast(project_id, {"type": "render_error", "error": str(e)})
        raise HTTPException(500, f"render failed: {e}") from e

    # Copy into media tree so the browser can stream it.
    media_renders = settings.media_dir / project_id / "_renders"
    media_renders.mkdir(parents=True, exist_ok=True)
    served = media_renders / result_path.name
    if not served.exists():
        served.write_bytes(result_path.read_bytes())
    relative = f"/media/{project_id}/_renders/{result_path.name}"

    await hub.broadcast(project_id, {"type": "render_done", "url": relative})
    return {
        "ok": True,
        "url": relative,
        "width": width,
        "height": height,
    }


@router.get("/{project_id}/download/{filename}")
async def download_render(project_id: str, filename: str) -> FileResponse:
    path = settings.renders_dir / project_id / filename
    if not path.exists():
        raise HTTPException(404, "render not found")
    return FileResponse(str(path), media_type="video/mp4", filename=filename)
