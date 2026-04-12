"""EDL arranger: turn (audio signals + clips) into a beat-synced cut list.

Strategy:
1. Build a list of candidate cut points from beats/downbeats, with density
   depending on section energy (chorus = denser cuts than verse).
2. Pull the cut point ~1 frame before a downbeat so the peak frame of the
   next clip lands on the hit (industry editor trick).
3. For each slot, pick a clip by matching clip.motion_energy to the
   section energy (quadratic cost), weighted by an anti-repetition penalty
   on clips used in the last K slots.
4. Choose an in-point inside the clip (pseudo-random from clip.id hash)
   so the same clip re-used later doesn't show the same frames.
"""
from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass

from backend.app.audio.signals import SignalBundle, Section
from backend.app.project.models import Clip, Cut
from backend.app.video.edl import EDL


@dataclass
class ArrangerConfig:
    fps: float = 30.0
    base_cut_density: float = 0.25
    section_energy_boost: float = 0.7
    pre_hit_offset_frames: int = 0
    anti_repeat_window: int = 3
    anti_repeat_penalty: float = 0.8
    min_cut_duration: float = 0.5
    max_cut_duration: float = 6.0


def arrange(
    bundle: SignalBundle,
    clips: list[Clip],
    config: ArrangerConfig | None = None,
) -> EDL:
    cfg = config or ArrangerConfig()
    eligible_clips = [c for c in clips if c.auto_arrange]
    if not eligible_clips:
        return EDL(fps=cfg.fps, duration=bundle.duration, cuts=[])

    cut_times = _choose_cut_times(bundle, cfg)
    slots: list[tuple[float, float, float]] = []

    for i, t in enumerate(cut_times):
        t_end = cut_times[i + 1] if i + 1 < len(cut_times) else bundle.duration
        if t_end - t < cfg.min_cut_duration:
            if slots:
                prev = slots[-1]
                slots[-1] = (prev[0], t_end, prev[2])
                continue
            # No previous slot (this is the first) — DON'T skip.
            # A short first slot is better than starting after 0.0.
        cursor = t
        while cursor < t_end:
            chunk_end = min(cursor + cfg.max_cut_duration, t_end)
            if chunk_end - cursor < cfg.min_cut_duration and slots:
                prev = slots[-1]
                slots[-1] = (prev[0], chunk_end, prev[2])
                break
            target = _energy_at(bundle.sections, (cursor + chunk_end) * 0.5)
            slots.append((cursor, chunk_end, target))
            cursor = chunk_end

    last_end = slots[-1][1] if slots else 0.0
    while last_end < bundle.duration:
        tail_end = min(last_end + cfg.max_cut_duration, bundle.duration)
        if tail_end - last_end < 0.01:
            break
        target = _energy_at(bundle.sections, (last_end + tail_end) * 0.5)
        slots.append((last_end, tail_end, target))
        last_end = tail_end

    if not slots and bundle.duration > 0:
        slots.append((0.0, bundle.duration, 0.5))

    raw_cuts = _assign_clips(slots, eligible_clips, cfg)
    cuts = _consolidate_anchor_runs(raw_cuts, eligible_clips)
    return EDL(fps=cfg.fps, duration=bundle.duration, cuts=cuts)


def _consolidate_anchor_runs(cuts: list[Cut], clips: list[Clip]) -> list[Cut]:
    """Merge consecutive cuts from the same anchored clip into one cut.

    After merging, each anchor cut's in_point is set to
    `t_start - anchor_offset` where anchor_offset is the earliest
    t_start for that clip. This means clip frame 0 plays at the
    anchor offset position on the song timeline.
    """
    anchor_ids = {c.id for c in clips if c.anchor}
    if not anchor_ids:
        return cuts

    sorted_cuts = sorted(cuts, key=lambda c: c.t_start)

    # Find anchor offset per clip (earliest t_start).
    anchor_offset: dict[str, float] = {}
    for cut in sorted_cuts:
        if cut.clip_id in anchor_ids:
            if cut.clip_id not in anchor_offset:
                anchor_offset[cut.clip_id] = cut.t_start

    merged: list[Cut] = []
    for cut in sorted_cuts:
        if (
            cut.clip_id in anchor_ids
            and merged
            and merged[-1].clip_id == cut.clip_id
            and abs(cut.t_start - merged[-1].t_end) < 0.01
        ):
            merged[-1] = Cut(
                t_start=merged[-1].t_start,
                t_end=cut.t_end,
                clip_id=cut.clip_id,
                in_point=merged[-1].in_point,
                speed=merged[-1].speed,
                locked=merged[-1].locked,
            )
        else:
            if cut.clip_id in anchor_ids:
                offset = anchor_offset.get(cut.clip_id, 0.0)
                merged.append(Cut(
                    t_start=cut.t_start,
                    t_end=cut.t_end,
                    clip_id=cut.clip_id,
                    in_point=max(0.0, cut.t_start - offset),
                    speed=cut.speed,
                    locked=cut.locked,
                ))
            else:
                merged.append(cut)

    # Clamp anchor cuts so they don't extend past the clip's footage.
    clip_dur = {c.id: c.duration for c in clips}
    clamped: list[Cut] = []
    for cut in merged:
        if cut.clip_id in anchor_ids:
            offset = anchor_offset.get(cut.clip_id, 0.0)
            cd = clip_dur.get(cut.clip_id, 0.0)
            max_end = offset + cd if cd > 0 else cut.t_end
            t_end = min(cut.t_end, max_end)
            if t_end <= cut.t_start:
                continue
            clamped.append(Cut(
                t_start=cut.t_start,
                t_end=t_end,
                clip_id=cut.clip_id,
                in_point=cut.in_point,
                speed=cut.speed,
                locked=cut.locked,
            ))
        else:
            clamped.append(cut)
    return clamped


def _choose_cut_times(bundle: SignalBundle, cfg: ArrangerConfig) -> list[float]:
    """Pick a subset of beats as cut points, denser in high-energy sections.

    Cut times land EXACTLY on beat times — no pre-hit offset. The preview
    engine handles frame timing; shifting t_start only causes perceived
    drift between the playhead cursor and the actual clip switch.

    Downbeats are always included. Non-downbeat candidates that fall
    immediately before a downbeat are suppressed to avoid a cut that steals
    the downbeat's visual impact.
    """
    beats = list(bundle.beat_times)
    downbeats_set = set(round(t, 3) for t in bundle.downbeat_times)
    if not beats:
        return [0.0]

    chosen: list[float] = [0.0]
    for i, t in enumerate(beats):
        is_downbeat = round(t, 3) in downbeats_set
        if is_downbeat:
            chosen.append(t)
            continue
        sec_energy = _energy_at(bundle.sections, t)
        density = cfg.base_cut_density + cfg.section_energy_boost * sec_energy
        keep = (i * density) % 1.0 < density
        if not keep:
            continue
        # Suppress non-downbeat cuts that land right before a downbeat —
        # the downbeat switch is more musically impactful.
        if i + 1 < len(beats) and round(beats[i + 1], 3) in downbeats_set:
            continue
        chosen.append(t)

    chosen = sorted(set(round(t, 4) for t in chosen))
    return chosen


def _energy_at(sections: list[Section], t: float) -> float:
    """Return the energy of the section containing time t, or 0.5 if unknown."""
    for s in sections:
        if s.start <= t < s.end:
            return max(0.0, min(1.0, s.energy))
    return 0.5


def _assign_clips(
    slots: list[tuple[float, float, float]],
    clips: list[Clip],
    cfg: ArrangerConfig,
) -> list[Cut]:
    """Bucketed energy-matched assignment with anti-repetition.

    Clips are split into LOW / MID / HIGH energy buckets (tertiles of motion
    energy). Each slot picks from the bucket that matches the section's
    energy target — intros pull from LOW, choruses from HIGH — which makes
    the video's visual arc mirror the music's arc.

    Anti-repetition still applies within a bucket.
    """
    if not clips:
        return []

    sorted_clips = sorted(clips, key=lambda c: c.motion_energy)
    n = len(sorted_clips)

    # With a small clip pool (<6), bucketing would leave the anti-repeat
    # logic with 1-clip options and force the same clip over and over. Fall
    # back to "all clips available, cost function does the energy match".
    USE_BUCKETS = n >= 6
    if USE_BUCKETS:
        t1 = max(1, n // 3)
        t2 = max(t1 + 1, (2 * n) // 3)
        low_bucket = sorted_clips[:t1]
        mid_bucket = sorted_clips[t1:t2]
        high_bucket = sorted_clips[t2:]
    else:
        low_bucket = mid_bucket = high_bucket = sorted_clips

    def pick_bucket(target: float) -> list[Clip]:
        if target < 0.33:
            return low_bucket
        if target < 0.66:
            return mid_bucket
        return high_bucket

    cuts: list[Cut] = []
    recent: list[str] = []

    for t_start, t_end, target in slots:
        bucket = pick_bucket(target)
        best_id: str | None = None
        best_cost = float("inf")
        for clip in bucket:
            # Anchor clips that are shorter than the song: don't schedule
            # them past their footage end (the footage is exhausted).
            if clip.anchor and clip.duration > 0 and t_start >= clip.duration:
                continue
            clip_energy = clip.motion_energy if clip.duration > 0 else 0.5
            cost = (clip_energy - target) ** 2
            if clip.id in recent[-cfg.anti_repeat_window :]:
                cost += cfg.anti_repeat_penalty
            cost += hash((clip.id, round(t_start, 3))) % 1000 / 1e6
            if cost < best_cost:
                best_cost = cost
                best_id = clip.id

        if best_id is None:
            for clip in sorted_clips:
                if clip.anchor and clip.duration > 0 and t_start >= clip.duration:
                    continue
                clip_energy = clip.motion_energy if clip.duration > 0 else 0.5
                cost = (clip_energy - target) ** 2
                if clip.id in recent[-cfg.anti_repeat_window :]:
                    cost += cfg.anti_repeat_penalty
                if cost < best_cost:
                    best_cost = cost
                    best_id = clip.id

        if best_id is None:
            continue
        clip = next(c for c in clips if c.id == best_id)
        recent.append(best_id)

        if clip.anchor:
            # in_point will be recomputed by _consolidate_anchor_runs
            # relative to the anchor offset (first segment's t_start).
            in_point = t_start
            if clip.duration > 0 and t_end > t_start + clip.duration:
                t_end = t_start + clip.duration
        else:
            in_point = _pick_in_point(clip, t_end - t_start)
        cuts.append(
            Cut(
                t_start=t_start,
                t_end=t_end,
                clip_id=best_id,
                in_point=in_point,
                speed=1.0,
                locked=False,
            )
        )

    return cuts


def _pick_in_point(clip: Clip, slot_duration: float) -> float:
    """Deterministic-ish in-point chosen from a hash of the clip + slot duration.

    Biases toward the middle third of the clip where motion tends to be strongest.
    """
    if clip.duration <= slot_duration + 0.05:
        return 0.0
    seed = int(hashlib.md5(f"{clip.id}:{slot_duration:.3f}".encode()).hexdigest(), 16)
    rng = random.Random(seed)
    lo = clip.duration * 0.15
    hi = max(lo, clip.duration - slot_duration - 0.05)
    return rng.uniform(lo, hi)
