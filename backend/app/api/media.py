from __future__ import annotations

import asyncio
import io
import logging
import uuid
from pathlib import Path

import av
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image

from backend.app.config import settings
from backend.app.media.ingest import IngestError, ingest_audio, ingest_video
from backend.app.project.models import AudioTrack, Clip
from backend.app.project.store import store
from backend.app.video.probe import probe_motion_energy

log = logging.getLogger(__name__)

router = APIRouter()


def _sanitize_name(name: str | None) -> str:
    name = name or "file"
    return "".join(c if c.isalnum() or c in ("-", "_", ".") else "_" for c in name)


async def _save_upload(file: UploadFile, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(await file.read())
    return target


@router.post("/{project_id}/audio")
async def upload_audio(project_id: str, file: UploadFile = File(...)) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")

    media_root = settings.media_dir / project_id
    orig_dir = media_root / "orig"
    orig_name = _sanitize_name(file.filename)
    orig_path = await _save_upload(file, orig_dir / f"audio_{orig_name}")

    out_path = media_root / "audio.flac"

    try:
        info = await asyncio.to_thread(ingest_audio, orig_path, out_path)
    except IngestError as e:
        log.warning("audio ingest failed: %s", e)
        raise HTTPException(400, f"unsupported or corrupt audio: {e}") from e

    project.audio = AudioTrack(
        filename=file.filename or info.path.name,
        path=str(info.path),
        url=f"/media/{project_id}/{info.path.name}",
        duration=info.duration,
        sr=info.sample_rate,
        analyzed=False,
    )
    store.save(project)
    return {
        "ok": True,
        "audio": project.audio.model_dump(mode="json"),
        "ingest": {
            "source_codec": info.codec,
            "transcoded": info.transcoded,
        },
    }


@router.post("/{project_id}/clips")
async def upload_clip(project_id: str, file: UploadFile = File(...)) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")

    media_root = settings.media_dir / project_id
    clips_dir = media_root / "clips"
    orig_dir = clips_dir / "orig"

    clip_id = uuid.uuid4().hex[:8]
    orig_name = _sanitize_name(file.filename)
    orig_path = await _save_upload(file, orig_dir / f"{clip_id}_{orig_name}")

    out_path = clips_dir / f"{clip_id}.mp4"

    try:
        info = await asyncio.to_thread(ingest_video, orig_path, out_path)
    except IngestError as e:
        log.warning("video ingest failed: %s", e)
        raise HTTPException(400, f"unsupported or corrupt video: {e}") from e

    clip = Clip(
        id=clip_id,
        filename=file.filename or info.path.name,
        path=str(info.path),
        url=f"/media/{project_id}/clips/{info.path.name}",
        duration=info.duration,
        width=info.width,
        height=info.height,
        fps=info.fps,
    )

    try:
        clip.motion_energy = await asyncio.to_thread(probe_motion_energy, info.path)
    except Exception as e:
        log.warning("motion probe failed for %s: %s", info.path.name, e)
        clip.motion_energy = 0.5

    project.clips.append(clip)
    store.save(project)
    return {
        "ok": True,
        "clip": clip.model_dump(mode="json"),
        "ingest": {
            "source_codec": info.codec,
            "transcoded": info.transcoded,
        },
    }


@router.delete("/{project_id}/clips/{clip_id}")
async def delete_clip(project_id: str, clip_id: str) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    before = len(project.clips)
    project.clips = [c for c in project.clips if c.id != clip_id]
    store.save(project)
    return {"deleted": before - len(project.clips)}


# ─── thumbnail ─────────────────────────────────────────────────────────────

def _extract_thumbnail(clip_path: Path, t_seconds: float, width: int) -> bytes:
    """Decode one frame at t_seconds from clip_path, resize to `width` and
    return JPEG bytes. Fast path: PyAV seek + single decode + Pillow encode.
    """
    container = av.open(str(clip_path))
    try:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            raise ValueError("no video stream")
        stream.thread_type = "AUTO"
        duration = (
            float(stream.duration * stream.time_base)
            if stream.duration
            else container.duration / av.time_base
        )
        t_seconds = max(0.0, min(max(0.0, duration - 0.05), t_seconds))
        if t_seconds > 0:
            seek_t = max(0.0, t_seconds - 0.5)
            container.seek(
                int(seek_t / stream.time_base),
                stream=stream,
                any_frame=False,
                backward=True,
            )
        picked = None
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            pts = float(frame.pts * stream.time_base)
            picked = frame
            if pts >= t_seconds:
                break
        if picked is None:
            raise ValueError("no decodable frame")
        rgb = picked.to_ndarray(format="rgb24")
    finally:
        container.close()

    img = Image.fromarray(rgb)
    if img.width != width:
        new_h = max(1, round(img.height * (width / img.width)))
        img = img.resize((width, new_h), Image.Resampling.BILINEAR)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=78, optimize=False)
    return buf.getvalue()


@router.get("/{project_id}/thumb")
async def clip_thumbnail(
    project_id: str, clip: str, t: float = 0.0, w: int = 160
) -> Response:
    """Return a JPEG thumbnail of clip `clip` at time `t` seconds, `w` wide.

    Disk-cached under storage/cache/thumbs/{clip_id}_{int(t*10):05d}_{w}.jpg.
    """
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    target = next((c for c in project.clips if c.id == clip), None)
    if target is None:
        raise HTTPException(404, "clip not found")
    width = max(32, min(512, int(w)))

    cache_dir = settings.cache_dir / "thumbs"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_name = f"{clip}_{int(max(0.0, t) * 10):05d}_{width}.jpg"
    cache_path = cache_dir / cache_name

    if not cache_path.exists():
        try:
            data = await asyncio.to_thread(
                _extract_thumbnail, Path(target.path), float(t), width
            )
        except Exception as e:
            log.warning("thumbnail failed for %s@%s: %s", clip, t, e)
            raise HTTPException(500, f"thumbnail generation failed: {e}") from e
        cache_path.write_bytes(data)

    return FileResponse(
        str(cache_path),
        media_type="image/jpeg",
        headers={"cache-control": "public, max-age=3600"},
    )
