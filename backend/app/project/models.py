from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(UTC)


class Clip(BaseModel):
    id: str
    filename: str
    path: str
    url: str = ""  # browser-visible URL under /media mount
    duration: float = 0.0
    width: int = 0
    height: int = 0
    fps: float = 0.0
    motion_energy: float = 0.0
    auto_arrange: bool = True  # if False, Arrange skips this clip entirely
    anchor: bool = False  # if True, in_point = t_start so footage stays synced to song time


class AudioTrack(BaseModel):
    filename: str
    path: str
    url: str = ""  # browser-visible URL under /media mount
    duration: float = 0.0
    sr: int = 0
    analyzed: bool = False


class Patch(BaseModel):
    """One modulation routing: signal -> parameter, with transform chain."""

    id: str
    source: str  # e.g. "drum_stem_rms", "beat", "bass_energy"
    target: str  # e.g. "zoom.amount", "rgbSplit.intensity", "clip_switch"
    enabled: bool = True
    smooth_ms: float = 0.0
    gate_threshold: float = 0.0
    curve: Literal["linear", "exp", "log", "s"] = "linear"
    scale_min: float = 0.0
    scale_max: float = 1.0
    latch_ms: float = 0.0
    # Optional list of section indices the patch is active in. None = always
    # active. [0, 2] = only during section 0 and section 2. Multiplies the
    # patch's output by the union of `section_N_active` signals for those
    # sections in the modulation bake.
    section_mask: list[int] | None = None


class EffectChainEntry(BaseModel):
    name: str
    enabled: bool = True
    base_params: dict[str, float] = Field(default_factory=dict)


class Cut(BaseModel):
    t_start: float
    t_end: float
    clip_id: str
    in_point: float = 0.0
    speed: float = 1.0
    locked: bool = False


class Project(BaseModel):
    id: str
    name: str
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
    audio: AudioTrack | None = None
    clips: list[Clip] = Field(default_factory=list)
    edl: list[Cut] = Field(default_factory=list)
    patches: list[Patch] = Field(default_factory=list)
    effect_chain: list[EffectChainEntry] = Field(default_factory=list)
    preset: str | None = None
    fps: float = 30.0
    width: int = 1920
    height: int = 1080
    beats_per_cut: int = 4
    beats_per_bar: int | None = None
