from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.app.audio.pipeline import cache_dir_for, file_sha
from backend.app.audio.signals import SignalBundle
from backend.app.config import settings
from backend.app.project.store import store
from backend.app.routing.auto import generate_auto_modulation
from backend.app.video.arranger import ArrangerConfig, arrange
from backend.app.ws.project_ws import hub

router = APIRouter()
log = logging.getLogger(__name__)


class ArrangeRequest(BaseModel):
    beats_per_cut: int | None = None


@router.post("/{project_id}")
async def arrange_project(project_id: str, req: ArrangeRequest | None = None) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    if project.audio is None:
        raise HTTPException(400, "project has no audio")
    if not project.clips:
        raise HTTPException(400, "project has no clips")

    bpc = (req.beats_per_cut if req and req.beats_per_cut else None) or project.beats_per_cut
    bpc = max(1, min(16, bpc))
    project.beats_per_cut = bpc

    sha = file_sha(Path(project.audio.path))
    cdir = cache_dir_for(sha, use_stems=settings.enable_stems)
    if not cdir.exists():
        raise HTTPException(400, "audio not analyzed yet")

    bundle = await asyncio.to_thread(SignalBundle.from_disk, cdir)
    cfg = ArrangerConfig(fps=project.fps, base_cut_density=1.0 / bpc)
    edl = arrange(bundle, project.clips, cfg)

    # Preserve locked cuts from prior arrangement.
    locked = {round(c.t_start, 3): c for c in project.edl if c.locked}
    merged = []
    for cut in edl.cuts:
        key = round(cut.t_start, 3)
        if key in locked:
            merged.append(locked[key])
        else:
            merged.append(cut)

    # Auto-generate a bold modulation matrix + effect chain as a starting
    # point. Users can tune from there in the UI.
    chain, patches = generate_auto_modulation(bundle)

    project.edl = merged
    project.effect_chain = chain
    project.patches = patches
    project.preset = None  # the auto-generated chain supersedes any preset
    store.save(project)

    await hub.broadcast(
        project_id,
        {
            "type": "arrange_done",
            "cut_count": len(merged),
            "patch_count": len(patches),
            "effect_count": len(chain),
        },
    )
    # Matrix/chain re-bake + preview refresh triggers.
    await hub.broadcast(project_id, {"type": "patches_changed"})
    await hub.broadcast(project_id, {"type": "effect_chain_changed"})

    return {
        "ok": True,
        "cut_count": len(merged),
        "edl": [c.model_dump(mode="json") for c in merged],
        "effect_chain": [e.model_dump(mode="json") for e in chain],
        "patches": [p.model_dump(mode="json") for p in patches],
    }
