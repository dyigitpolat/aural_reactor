from __future__ import annotations

import struct
import uuid
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from backend.app.audio.pipeline import cache_dir_for, file_sha
from backend.app.audio.signals import DISCRETE_TRIGGERS, SignalBundle
from backend.app.config import settings
from backend.app.project.models import EffectChainEntry, Patch
from backend.app.project.store import store
from backend.app.routing.matrix import bake
from backend.app.routing.presets import apply_preset, list_presets
from backend.app.video.effects import EFFECTS
from backend.app.ws.project_ws import hub

router = APIRouter()


class PatchCreate(BaseModel):
    source: str
    target: str
    enabled: bool = True
    smooth_ms: float = 0.0
    gate_threshold: float = 0.0
    curve: str = "linear"
    scale_min: float = 0.0
    scale_max: float = 1.0
    latch_ms: float = 0.0


class PatchUpdate(PatchCreate):
    pass


class EffectChainPayload(BaseModel):
    chain: list[EffectChainEntry]


def _valid_targets() -> set[str]:
    targets: set[str] = set()
    for spec in EFFECTS:
        for u in spec.uniforms:
            targets.add(f"{spec.name}.{u.param}")
    return targets


def _valid_sources(bundle: SignalBundle | None) -> set[str]:
    if bundle is None:
        return set()
    return set(bundle.continuous.keys()) | set(DISCRETE_TRIGGERS)


def _load_bundle(project) -> SignalBundle | None:
    if project.audio is None:
        return None
    try:
        sha = file_sha(Path(project.audio.path))
    except FileNotFoundError:
        return None
    cdir = cache_dir_for(sha, use_stems=settings.enable_stems)
    if not cdir.exists():
        return None
    return SignalBundle.from_disk(cdir)


@router.get("/{project_id}/sources")
async def get_sources(project_id: str) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    bundle = _load_bundle(project)
    return {
        "continuous": sorted(bundle.continuous.keys()) if bundle else [],
        "triggers": list(DISCRETE_TRIGGERS),
        "has_analysis": bundle is not None,
    }


@router.get("/{project_id}/targets")
async def get_targets() -> dict:
    out: list[dict] = []
    for spec in EFFECTS:
        for u in spec.uniforms:
            out.append(
                {
                    "target": f"{spec.name}.{u.param}",
                    "effect": spec.name,
                    "param": u.param,
                    "min": u.min,
                    "max": u.max,
                    "default": u.default,
                }
            )
    return {"targets": out}


@router.get("/{project_id}/patches")
async def get_patches(project_id: str) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    return {
        "patches": [p.model_dump(mode="json") for p in project.patches],
        "effect_chain": [e.model_dump(mode="json") for e in project.effect_chain],
    }


@router.post("/{project_id}/patches")
async def create_patch(project_id: str, req: PatchCreate) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    _validate_patch_targets(req.target)
    patch = Patch(id=uuid.uuid4().hex[:8], **req.model_dump())
    project.patches.append(patch)
    store.save(project)
    await hub.broadcast(project_id, {"type": "patches_changed"})
    return patch.model_dump(mode="json")


@router.put("/{project_id}/patches/{patch_id}")
async def update_patch(project_id: str, patch_id: str, req: PatchUpdate) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    _validate_patch_targets(req.target)
    for i, p in enumerate(project.patches):
        if p.id == patch_id:
            project.patches[i] = Patch(id=patch_id, **req.model_dump())
            store.save(project)
            await hub.broadcast(project_id, {"type": "patches_changed"})
            return project.patches[i].model_dump(mode="json")
    raise HTTPException(404, "patch not found")


@router.delete("/{project_id}/patches/{patch_id}")
async def delete_patch(project_id: str, patch_id: str) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    before = len(project.patches)
    project.patches = [p for p in project.patches if p.id != patch_id]
    store.save(project)
    await hub.broadcast(project_id, {"type": "patches_changed"})
    return {"deleted": before - len(project.patches)}


class PatchesBulkPayload(BaseModel):
    patches: list[Patch]


@router.put("/{project_id}/patches")
async def set_patches(project_id: str, req: PatchesBulkPayload) -> dict:
    """Replace the entire patch list in one round-trip.

    Used by the ModulationMatrix UI for 'Clear all', bulk enable/disable,
    and any other multi-patch operation — avoids the N-round-trip pattern
    of deleting patches one at a time.
    """
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    valid_targets = _valid_targets() | {"clip_switch"}
    for p in req.patches:
        if p.target not in valid_targets:
            raise HTTPException(400, f"invalid target {p.target}")
    # Preserve or assign ids (UI may send existing ids unchanged).
    cleaned: list[Patch] = []
    for p in req.patches:
        if not p.id:
            p = Patch(**{**p.model_dump(), "id": uuid.uuid4().hex[:8]})
        cleaned.append(p)
    project.patches = cleaned
    store.save(project)
    await hub.broadcast(project_id, {"type": "patches_changed"})
    return {
        "ok": True,
        "count": len(cleaned),
        "patches": [p.model_dump(mode="json") for p in cleaned],
    }


@router.post("/{project_id}/auto-regenerate")
async def auto_regenerate(project_id: str) -> dict:
    """Rerun the auto-modulation generator without touching the EDL.

    Used by the 'Reset to auto' button in the modulation matrix UI so the
    user can experiment freely and always snap back to a sensible default.
    """
    from pathlib import Path as _Path

    from backend.app.audio.pipeline import cache_dir_for, file_sha
    from backend.app.audio.signals import SignalBundle
    from backend.app.config import settings as _settings
    from backend.app.routing.auto import generate_auto_modulation

    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    if project.audio is None:
        raise HTTPException(400, "project has no audio")
    sha = file_sha(_Path(project.audio.path))
    cdir = cache_dir_for(sha, use_stems=_settings.enable_stems)
    if not cdir.exists():
        raise HTTPException(400, "audio not analyzed yet")
    bundle = SignalBundle.from_disk(cdir)
    chain, patches = generate_auto_modulation(bundle)
    project.effect_chain = chain
    project.patches = patches
    project.preset = None
    store.save(project)
    await hub.broadcast(project_id, {"type": "patches_changed"})
    await hub.broadcast(project_id, {"type": "effect_chain_changed"})
    return {
        "ok": True,
        "effect_chain": [e.model_dump(mode="json") for e in chain],
        "patches": [p.model_dump(mode="json") for p in patches],
    }


@router.post("/{project_id}/randomize")
async def randomize_patches(project_id: str) -> dict:
    """Generate random-but-punchy modulation patches without touching the EDL.

    Uses the existing effect chain (or a fresh default) and wires trigger
    sources to punch effects, continuous sources to flow effects, with
    aggressive scale/latch/curve settings.
    """
    import random as _random
    import uuid as _uuid
    from backend.app.routing.auto import _default_chain

    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")

    bundle = _load_bundle(project)
    sources_c = sorted(bundle.continuous.keys()) if bundle else []
    sources_t = list(DISCRETE_TRIGGERS)

    chain = project.effect_chain if project.effect_chain else _default_chain()
    enabled = {e.name for e in chain if e.enabled}

    # Categorize effects into punch (trigger-driven) and flow (continuous-driven).
    punch_effects = {"zoom", "shake", "rgb_split", "contrast_pump"} & enabled
    flow_effects = {"bloom", "light_leak"} & enabled
    trigger_pool = [s for s in sources_t if s not in ("beat", "bar_start", "section_change")]
    cont_pool = [s for s in sources_c if s in ("rms", "bass_rms", "bass_energy", "drum_rms", "spectral_flux")]

    rng = _random.Random()
    patches: list[Patch] = []

    def _mkpatch(source: str, target: str, **kw) -> Patch:
        base = dict(
            id=_uuid.uuid4().hex[:8],
            source=source,
            target=target,
            enabled=True,
            smooth_ms=rng.uniform(5, 30),
            gate_threshold=0.0,
            curve=rng.choice(["exp", "s"]),
            scale_min=0.0,
            scale_max=round(rng.uniform(0.55, 0.95), 2),
            latch_ms=round(rng.uniform(40, 200), 0),
            section_mask=None,
        )
        base.update(kw)
        return Patch(**base)

    for eff in punch_effects:
        if trigger_pool:
            src = rng.choice(trigger_pool)
            patches.append(_mkpatch(src, f"{eff}.intensity"))

    for eff in flow_effects:
        if cont_pool:
            src = rng.choice(cont_pool)
            patches.append(_mkpatch(src, f"{eff}.intensity", smooth_ms=round(rng.uniform(60, 200), 0)))

    project.effect_chain = chain
    project.patches = patches
    project.preset = None
    store.save(project)
    await hub.broadcast(project_id, {"type": "patches_changed"})
    await hub.broadcast(project_id, {"type": "effect_chain_changed"})
    return {
        "ok": True,
        "effect_chain": [e.model_dump(mode="json") for e in chain],
        "patches": [p.model_dump(mode="json") for p in patches],
    }


@router.put("/{project_id}/effect-chain")
async def set_effect_chain(project_id: str, req: EffectChainPayload) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    project.effect_chain = req.chain
    store.save(project)
    await hub.broadcast(project_id, {"type": "effect_chain_changed"})
    return {"ok": True, "count": len(project.effect_chain)}


@router.get("/presets")
async def get_presets() -> dict:
    return {"presets": list_presets()}


@router.post("/{project_id}/presets/{name}")
async def use_preset(project_id: str, name: str) -> dict:
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    try:
        chain, patches = apply_preset(name)
    except KeyError:
        raise HTTPException(404, f"unknown preset {name}") from None
    project.effect_chain = chain
    project.patches = patches
    project.preset = name
    store.save(project)
    await hub.broadcast(project_id, {"type": "preset_applied", "preset": name})
    return {
        "ok": True,
        "preset": name,
        "effect_chain": [e.model_dump(mode="json") for e in chain],
        "patches": [p.model_dump(mode="json") for p in patches],
    }


@router.get("/{project_id}/bake")
async def bake_modulation(project_id: str) -> Response:
    """Bake all patches to Float32 arrays. Returns a packed binary blob.

    Layout:
      uint32  n_targets
      uint32  n_frames
      float32 rate_hz
      float32 duration
      for each target:
        uint16  name_len
        char[]  name (utf8)
        float32[n_frames] values
    """
    project = store.load(project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    bundle = _load_bundle(project)
    if bundle is None:
        raise HTTPException(400, "audio not analyzed yet")

    baked = bake(bundle, project.patches)
    n_frames = int(round(bundle.duration * bundle.rate_hz))

    buf = bytearray()
    buf.extend(struct.pack("<II", len(baked.targets), n_frames))
    buf.extend(struct.pack("<ff", bundle.rate_hz, bundle.duration))
    for name, arr in baked.targets.items():
        name_bytes = name.encode("utf-8")
        buf.extend(struct.pack("<H", len(name_bytes)))
        buf.extend(name_bytes)
        # Pad / truncate to n_frames so client code is simple
        if arr.size < n_frames:
            padded = np.zeros(n_frames, dtype=np.float32)
            padded[: arr.size] = arr
            arr = padded
        elif arr.size > n_frames:
            arr = arr[:n_frames]
        buf.extend(arr.astype(np.float32).tobytes())

    return Response(
        content=bytes(buf),
        media_type="application/octet-stream",
        headers={
            "x-target-count": str(len(baked.targets)),
            "x-n-frames": str(n_frames),
            "x-rate-hz": str(bundle.rate_hz),
        },
    )


def _validate_patch_targets(target: str) -> None:
    if target not in _valid_targets() and target != "clip_switch":
        raise HTTPException(400, f"invalid target {target}")
