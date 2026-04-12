from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.app.project.models import Cut, Project
from backend.app.project.store import store
from backend.app.ws.project_ws import hub

router = APIRouter()


class CreateProjectRequest(BaseModel):
    name: str


class ResolutionRequest(BaseModel):
    width: int = Field(..., ge=16, le=7680)
    height: int = Field(..., ge=16, le=7680)
    fps: float | None = Field(None, gt=0, le=120)


class EdlUpdateRequest(BaseModel):
    edl: list[Cut]


class ClipPatchRequest(BaseModel):
    auto_arrange: bool | None = None
    anchor: bool | None = None


RESOLUTION_PRESETS: list[dict] = [
    {"label": "Full HD · 1920×1080", "width": 1920, "height": 1080, "group": "landscape"},
    {"label": "QHD · 2560×1440", "width": 2560, "height": 1440, "group": "landscape"},
    {"label": "4K · 3840×2160", "width": 3840, "height": 2160, "group": "landscape"},
    {"label": "HD · 1280×720", "width": 1280, "height": 720, "group": "landscape"},
    {"label": "Vertical Full HD · 1080×1920", "width": 1080, "height": 1920, "group": "portrait"},
    {"label": "Vertical HD · 720×1280", "width": 720, "height": 1280, "group": "portrait"},
    {"label": "Square · 1080×1080", "width": 1080, "height": 1080, "group": "square"},
    {"label": "Square 4K · 2160×2160", "width": 2160, "height": 2160, "group": "square"},
]


@router.get("/presets/resolutions")
async def get_resolution_presets() -> dict:
    return {"presets": RESOLUTION_PRESETS}


@router.post("", response_model=Project)
async def create_project(req: CreateProjectRequest) -> Project:
    return store.create(req.name)


@router.get("", response_model=list[Project])
async def list_projects() -> list[Project]:
    return store.list()


class RenameRequest(BaseModel):
    name: str


@router.patch("/{project_id}/rename", response_model=Project)
async def rename_project(project_id: str, req: RenameRequest) -> Project:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    project.name = req.name
    store.save(project)
    return project


@router.get("/{project_id}", response_model=Project)
async def get_project(project_id: str) -> Project:
    p = store.load(project_id)
    if p is None:
        raise HTTPException(404, "project not found")
    return p


@router.put("/{project_id}/resolution", response_model=Project)
async def set_resolution(project_id: str, req: ResolutionRequest) -> Project:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    project.width = req.width
    project.height = req.height
    if req.fps is not None:
        project.fps = req.fps
    store.save(project)
    return project


class MeterRequest(BaseModel):
    beats_per_bar: int | None = None


@router.put("/{project_id}/meter", response_model=Project)
async def set_meter(project_id: str, req: MeterRequest) -> Project:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    project.beats_per_bar = req.beats_per_bar
    store.save(project)
    return project


@router.put("/{project_id}/edl", response_model=Project)
async def update_edl(project_id: str, req: EdlUpdateRequest) -> Project:
    """Replace the entire EDL with a validated list of cuts.

    This is the one endpoint the ClipStrip UI uses for every mutation:
    trim, replace-clip, delete, reorder, insert. Client-side optimistic
    updates + one round-trip here = instant UX without per-cut endpoints.
    """
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")

    valid_clip_ids = {c.id for c in project.clips}
    duration = project.audio.duration if project.audio else 0.0

    cleaned: list[Cut] = []
    for raw in req.edl:
        if raw.clip_id not in valid_clip_ids:
            raise HTTPException(
                400, f"cut references unknown clip_id: {raw.clip_id}"
            )
        t_start = max(0.0, raw.t_start)
        t_end = raw.t_end
        if duration > 0:
            t_start = min(t_start, duration)
            t_end = min(t_end, duration)
        if t_end <= t_start:
            raise HTTPException(
                400, f"cut has non-positive duration: {t_start}..{t_end}"
            )
        in_point = max(0.0, raw.in_point)
        cleaned.append(
            Cut(
                t_start=t_start,
                t_end=t_end,
                clip_id=raw.clip_id,
                in_point=in_point,
                speed=1.0,  # speed stays 1 — speed changes come from effects
                locked=bool(raw.locked),
            )
        )

    cleaned.sort(key=lambda c: c.t_start)

    # Enforce anchor invariants:
    #   in_point = t_start - anchor_offset (where anchor_offset is the
    #   earliest segment's t_start for this clip — the "anchor start handle").
    #   This means clip frame 0 plays at anchor_offset on the song timeline.
    anchor_ids = {c.id for c in project.clips if c.anchor}
    clip_dur = {c.id: c.duration for c in project.clips}
    if anchor_ids:
        # Find the anchor offset (earliest t_start) per anchor clip.
        anchor_offset: dict[str, float] = {}
        for c in cleaned:
            if c.clip_id in anchor_ids:
                if c.clip_id not in anchor_offset or c.t_start < anchor_offset[c.clip_id]:
                    anchor_offset[c.clip_id] = c.t_start

        enforced: list[Cut] = []
        for c in cleaned:
            if c.clip_id in anchor_ids:
                cd = clip_dur.get(c.clip_id, 0.0)
                offset = anchor_offset.get(c.clip_id, 0.0)
                in_point = c.t_start - offset
                t_end = c.t_end
                # Clamp: in_point can't exceed clip duration.
                if cd > 0 and in_point + (t_end - c.t_start) > cd:
                    t_end = c.t_start + max(0.1, cd - in_point)
                if t_end <= c.t_start:
                    t_end = c.t_start + 0.1
                enforced.append(Cut(
                    t_start=c.t_start,
                    t_end=t_end,
                    clip_id=c.clip_id,
                    in_point=max(0.0, in_point),
                    speed=c.speed,
                    locked=c.locked,
                ))
            else:
                enforced.append(c)
        cleaned = enforced

    project.edl = cleaned
    store.save(project)

    await hub.broadcast(
        project_id,
        {"type": "edl_changed", "cut_count": len(cleaned)},
    )
    return project


@router.patch("/{project_id}/clips/{clip_id}", response_model=Project)
async def patch_clip(project_id: str, clip_id: str, req: ClipPatchRequest) -> Project:
    """Update mutable clip fields (currently only `auto_arrange`)."""
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    for clip in project.clips:
        if clip.id == clip_id:
            if req.auto_arrange is not None:
                clip.auto_arrange = req.auto_arrange
            if req.anchor is not None:
                clip.anchor = req.anchor
            store.save(project)
            return project
    raise HTTPException(404, f"clip {clip_id} not found")


@router.delete("/{project_id}")
async def delete_project(project_id: str) -> dict[str, bool]:
    return {"deleted": store.delete(project_id)}
