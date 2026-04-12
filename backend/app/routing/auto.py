"""Auto-generate a modulation matrix + effect chain that TELLS A STORY.

Design:
  - Always-on cinematic baseline: vignette, grain, contrast_pump saturation.
    Cheap, subtle, always present.

  - Section-scoped patches: each detected section gets its own "vibe" of
    modulation patches, gated via Patch.section_mask. A 4-section song looks
    roughly like:

      section 0 (intro) : only subtle modulation — bass→bloom, soft light_leak.
                          no zoom punches, no glitch, no shake.
      section 1 (verse) : add downbeat→zoom (mild), bass→bloom (stronger).
                          still restrained — carrying the song without
                          overwhelming it.
      section 2 (chorus): full rhythmic kit — downbeat→zoom, kick→contrast,
                          snare→shake, hi_hat→rgb_split, drop→bloom burst.
      section 3+ (outro): echo the intro — back to bass→bloom + light_leak,
                          no shake, no glitch.

  - Sections are assigned roles by energy rank: lowest-energy section = intro,
    highest = chorus, middle = verse, next-to-last echoes intro. This makes
    the story match the music even for songs that don't have obvious
    intro/chorus boundaries.

Any effect the user wants off permanently can be disabled in the effect chain
(or by deleting its patches). kaleidoscope, glitch, pixelate, feedback remain
disabled in the default chain since they're easy to overdo.
"""
from __future__ import annotations

import uuid

from backend.app.audio.signals import SignalBundle, Section
from backend.app.project.models import EffectChainEntry, Patch


def _patch(source: str, target: str, section_mask: list[int] | None = None, **kw) -> Patch:
    base = dict(
        id=uuid.uuid4().hex[:8],
        source=source,
        target=target,
        enabled=True,
        smooth_ms=0.0,
        gate_threshold=0.0,
        curve="linear",
        scale_min=0.0,
        scale_max=1.0,
        latch_ms=0.0,
        section_mask=section_mask,
    )
    base.update(kw)
    return Patch(**base)


def _default_chain() -> list[EffectChainEntry]:
    """Cinematic baseline chain. 8 of 12 effects enabled; destructive ones off.

    Base params are tuned so the *static* look already has visible character
    before any modulation kicks in — grain, deep vignette, lifted contrast,
    mild always-on bloom and a touch of warm light-leak. Modulation piles
    additional punches on top of this floor during choruses.
    """
    return [
        EffectChainEntry(
            name="contrast_pump",
            enabled=True,
            base_params={"intensity": 0.32, "saturation": 0.55},
        ),
        EffectChainEntry(
            name="grain",
            enabled=True,
            base_params={"intensity": 0.18, "size": 0.55},
        ),
        EffectChainEntry(
            name="vignette",
            enabled=True,
            base_params={"intensity": 0.55, "exposure": -0.05},
        ),
        EffectChainEntry(
            name="zoom",
            enabled=True,
            base_params={"intensity": 0.0, "centerX": 0.5, "centerY": 0.5},
        ),
        EffectChainEntry(
            name="shake",
            enabled=True,
            base_params={"intensity": 0.0, "freq": 14.0},
        ),
        EffectChainEntry(
            name="rgb_split",
            enabled=True,
            base_params={"intensity": 0.0, "angle": 0.0},
        ),
        EffectChainEntry(
            name="bloom",
            enabled=True,
            base_params={"intensity": 0.18, "threshold": 0.70},
        ),
        EffectChainEntry(
            name="light_leak",
            enabled=True,
            base_params={"intensity": 0.08, "hue": 0.08},
        ),
        EffectChainEntry(
            name="kaleidoscope",
            enabled=False,
            base_params={"intensity": 0.0, "segments": 6.0, "rotation": 0.0},
        ),
        EffectChainEntry(
            name="glitch",
            enabled=False,
            base_params={"intensity": 0.0, "seed": 7.2},
        ),
        EffectChainEntry(
            name="pixelate",
            enabled=False,
            base_params={"intensity": 0.0, "aspect": 16.0 / 9.0},
        ),
        EffectChainEntry(
            name="feedback",
            enabled=False,
            base_params={"intensity": 0.0, "zoom": 1.5},
        ),
    ]


# ─── Section role assignment ────────────────────────────────────────────────


def _assign_section_roles(sections: list[Section]) -> dict[int, str]:
    """Label each section as 'intro' / 'verse' / 'chorus' / 'outro'.

    Strategy: sort sections by energy, assign roles by rank AND position.
    The lowest-energy section becomes the intro, the highest becomes the
    chorus-like peak, the last section becomes the outro. Everything in
    between is a 'verse'.
    """
    if not sections:
        return {}
    n = len(sections)
    roles: dict[int, str] = {}
    if n == 1:
        return {0: "chorus"}
    if n == 2:
        # Just intro + peak
        order = sorted(range(n), key=lambda i: sections[i].energy)
        roles[order[0]] = "intro"
        roles[order[1]] = "chorus"
        return roles

    # First section → intro, last section → outro, everything else gets
    # role by energy rank.
    roles[0] = "intro"
    roles[n - 1] = "outro"

    middle_indices = list(range(1, n - 1))
    if not middle_indices:
        return roles

    # Sort middle sections by energy and assign:
    # highest → chorus, next → chorus, lowest → verse
    middle_sorted = sorted(middle_indices, key=lambda i: -sections[i].energy)
    for rank, idx in enumerate(middle_sorted):
        if rank == 0:
            roles[idx] = "chorus"
        elif rank == 1 and n >= 5:
            roles[idx] = "chorus"  # multi-chorus songs
        else:
            roles[idx] = "verse"
    return roles


# ─── Patch recipes per section role ─────────────────────────────────────────


def _intro_patches(section_idx: int, bundle: SignalBundle) -> list[Patch]:
    """Subtle, warm, no rhythmic punches. Sets the stage."""
    patches: list[Patch] = []
    continuous = bundle.continuous

    bass_src = "bass_rms" if "bass_rms" in continuous else "bass_energy"
    if bass_src in continuous:
        patches.append(_patch(
            bass_src, "bloom.intensity",
            section_mask=[section_idx],
            smooth_ms=200.0, scale_min=0.10, scale_max=0.45, curve="s",
        ))

    if "rms" in continuous:
        patches.append(_patch(
            "rms", "vignette.intensity",
            section_mask=[section_idx],
            smooth_ms=300.0, scale_min=0.50, scale_max=0.70,
        ))

    vocal_src = "vocals_rms" if "vocals_rms" in continuous else None
    if vocal_src:
        patches.append(_patch(
            vocal_src, "light_leak.intensity",
            section_mask=[section_idx],
            smooth_ms=200.0, scale_min=0.10, scale_max=0.60, curve="s",
        ))

    return patches


def _verse_patches(section_idx: int, bundle: SignalBundle) -> list[Patch]:
    """Restrained rhythmic motion — start of the story's movement."""
    patches: list[Patch] = []
    continuous = bundle.continuous

    if bundle.events.get("downbeat"):
        patches.append(_patch(
            "downbeat", "zoom.intensity",
            section_mask=[section_idx],
            smooth_ms=10.0, latch_ms=110.0, curve="exp", scale_max=0.60,
        ))

    bass_src = "bass_rms" if "bass_rms" in continuous else "bass_energy"
    if bass_src in continuous:
        patches.append(_patch(
            bass_src, "bloom.intensity",
            section_mask=[section_idx],
            smooth_ms=120.0, scale_min=0.15, scale_max=0.70, curve="s",
        ))

    drum_src = "drums_rms" if "drums_rms" in continuous else "percussiveness"
    if drum_src in continuous:
        patches.append(_patch(
            drum_src, "contrast_pump.intensity",
            section_mask=[section_idx],
            smooth_ms=30.0, scale_max=0.75, curve="exp",
        ))

    vocal_src = "vocals_rms" if "vocals_rms" in continuous else None
    if vocal_src:
        patches.append(_patch(
            vocal_src, "light_leak.intensity",
            section_mask=[section_idx],
            smooth_ms=150.0, scale_min=0.10, scale_max=0.70, curve="s",
        ))

    return patches


def _chorus_patches(section_idx: int, bundle: SignalBundle) -> list[Patch]:
    """Full rhythmic kit. The visual peak."""
    patches: list[Patch] = []
    continuous = bundle.continuous

    if bundle.events.get("downbeat"):
        patches.append(_patch(
            "downbeat", "zoom.intensity",
            section_mask=[section_idx],
            smooth_ms=8.0, latch_ms=120.0, curve="exp", scale_max=0.90,
        ))

    drum_src = "drums_rms" if "drums_rms" in continuous else "percussiveness"
    if drum_src in continuous:
        patches.append(_patch(
            drum_src, "contrast_pump.intensity",
            section_mask=[section_idx],
            smooth_ms=15.0, scale_max=0.95, curve="exp",
        ))
        patches.append(_patch(
            drum_src, "shake.intensity",
            section_mask=[section_idx],
            smooth_ms=20.0, gate_threshold=0.5, scale_max=0.75, curve="exp",
        ))

    treble_src = "treble_energy" if "treble_energy" in continuous else None
    if treble_src:
        patches.append(_patch(
            treble_src, "rgb_split.intensity",
            section_mask=[section_idx],
            smooth_ms=15.0, gate_threshold=0.3, scale_max=0.55, curve="exp",
        ))

    bass_src = "bass_rms" if "bass_rms" in continuous else "bass_energy"
    if bass_src in continuous:
        patches.append(_patch(
            bass_src, "bloom.intensity",
            section_mask=[section_idx],
            smooth_ms=80.0, scale_min=0.25, scale_max=0.95, curve="s",
        ))

    return patches


def _outro_patches(section_idx: int, bundle: SignalBundle) -> list[Patch]:
    """Mirror the intro — fade the rhythmic patches, keep baseline glow."""
    patches: list[Patch] = []
    continuous = bundle.continuous

    bass_source = "bass_rms" if (bundle.has_stems and "bass_rms" in continuous) else "bass_energy"
    if bass_source in continuous:
        patches.append(_patch(
            bass_source, "bloom.intensity",
            section_mask=[section_idx],
            smooth_ms=250.0, scale_min=0.10, scale_max=0.50, curve="s",
        ))

    if "rms" in continuous:
        patches.append(_patch(
            "rms", "vignette.intensity",
            section_mask=[section_idx],
            smooth_ms=400.0, scale_min=0.55, scale_max=0.75,
        ))

    return patches


# ─── Global (section-agnostic) patches ──────────────────────────────────────


def _global_patches(bundle: SignalBundle) -> list[Patch]:
    """Patches that should fire regardless of section — things that mark
    one-off moments like drops, which don't care about the section role.
    """
    patches: list[Patch] = []
    events = bundle.events

    if events.get("drop_detected"):
        patches.append(_patch(
            "drop_detected", "bloom.intensity",
            smooth_ms=40.0, latch_ms=750.0, curve="exp", scale_min=0.0, scale_max=0.90,
        ))
        patches.append(_patch(
            "drop_detected", "light_leak.intensity",
            smooth_ms=40.0, latch_ms=900.0, curve="exp", scale_min=0.0, scale_max=0.95,
        ))

    if events.get("section_change"):
        patches.append(_patch(
            "section_change", "light_leak.intensity",
            smooth_ms=60.0, latch_ms=700.0, curve="exp", scale_min=0.0, scale_max=0.7,
        ))

    return patches


def generate_auto_modulation(
    bundle: SignalBundle,
) -> tuple[list[EffectChainEntry], list[Patch]]:
    """Return (effect_chain, patches) with per-section story progression."""
    sections = bundle.sections
    roles = _assign_section_roles(sections)

    patches: list[Patch] = []

    # Per-section role-based patches.
    for section_idx, role in roles.items():
        if role == "intro":
            patches.extend(_intro_patches(section_idx, bundle))
        elif role == "verse":
            patches.extend(_verse_patches(section_idx, bundle))
        elif role == "chorus":
            patches.extend(_chorus_patches(section_idx, bundle))
        elif role == "outro":
            patches.extend(_outro_patches(section_idx, bundle))

    # Fallback: if we have no sections at all (shouldn't happen), treat the
    # whole song as a verse.
    if not roles:
        patches.extend(_verse_patches(0, bundle))

    # Section-agnostic patches on top (drops, section boundaries).
    patches.extend(_global_patches(bundle))

    return _default_chain(), patches
