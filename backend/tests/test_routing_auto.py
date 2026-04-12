"""Tests for the auto-modulation generator used by Arrange."""
from __future__ import annotations

import numpy as np

from backend.app.audio.signals import Section, SignalBundle
from backend.app.routing.auto import generate_auto_modulation


def _bundle(has_stems: bool = True) -> SignalBundle:
    rate_hz = 100.0
    duration = 16.0
    n = int(duration * rate_hz)

    continuous = {
        "rms": np.linspace(0.2, 0.9, n).astype(np.float32),
        "bass_energy": np.linspace(0.1, 0.8, n).astype(np.float32),
        "mid_energy": np.linspace(0.3, 0.6, n).astype(np.float32),
        "treble_energy": np.linspace(0.2, 0.7, n).astype(np.float32),
        "spectral_centroid": np.linspace(0.3, 0.7, n).astype(np.float32),
        "spectral_flux": np.linspace(0.2, 0.8, n).astype(np.float32),
        "harmonicity": np.linspace(0.3, 0.7, n).astype(np.float32),
        "percussiveness": np.linspace(0.1, 0.6, n).astype(np.float32),
    }
    if has_stems:
        continuous["drums_rms"] = np.linspace(0.3, 0.9, n).astype(np.float32)
        continuous["bass_rms"] = np.linspace(0.2, 0.8, n).astype(np.float32)
        continuous["vocals_rms"] = np.linspace(0.0, 0.6, n).astype(np.float32)
        continuous["other_rms"] = np.linspace(0.1, 0.5, n).astype(np.float32)

    # Pretend we've already computed section_N_active signals like the real
    # pipeline does. Four sections spanning 0..4, 4..8, 8..12, 12..16.
    sections_info = [
        (0.0, 4.0, 0.25, "A"),   # intro
        (4.0, 8.0, 0.55, "B"),   # verse
        (8.0, 12.0, 0.90, "C"),  # chorus (peak)
        (12.0, 16.0, 0.35, "D"), # outro
    ]
    for i, (s, e, _en, _label) in enumerate(sections_info):
        sig = np.zeros(n, dtype=np.float32)
        lo = int(s * rate_hz)
        hi = int(e * rate_hz)
        sig[lo:hi] = 1.0
        continuous[f"section_{i}_active"] = sig

    beats = [i * 0.5 for i in range(32)]
    downbeats = beats[::4]

    events = {
        "beat": beats,
        "downbeat": downbeats,
        "bar_start": downbeats,
        "drop_detected": [4.0, 12.0],
        "section_change": [4.0, 8.0, 12.0],
    }

    bundle = SignalBundle(
        duration=duration,
        sr=22050,
        rate_hz=rate_hz,
        tempo_bpm=120.0,
        continuous=continuous,
        events=events,
        beat_times=beats,
        downbeat_times=downbeats,
        has_stems=has_stems,
    )
    bundle.sections = [
        Section(start=s, end=e, label=label, energy=en)
        for s, e, en, label in sections_info
    ]
    return bundle


# Effects intentionally NOT auto-routed by the orchestrator.
DESTRUCTIVE_EFFECTS = {"kaleidoscope", "glitch", "pixelate", "feedback"}


def test_chain_enables_baseline_effects_but_not_destructive_ones():
    bundle = _bundle(has_stems=True)
    chain, _patches = generate_auto_modulation(bundle)

    # Always returns the full 12-effect schema (so the UI can show them all).
    assert len(chain) == 12

    enabled = {e.name for e in chain if e.enabled}
    disabled = {e.name for e in chain if not e.enabled}

    # Cinematic baseline always on.
    for required in ("vignette", "grain", "contrast_pump"):
        assert required in enabled, f"{required} should be in default chain"

    # Punch targets enabled so modulation can drive them.
    for required in ("zoom", "shake", "rgb_split", "bloom", "light_leak"):
        assert required in enabled, f"{required} should be enabled for punch routing"

    # Destructive effects intentionally disabled.
    for d in DESTRUCTIVE_EFFECTS:
        assert d in disabled, f"{d} should be disabled by default"


def test_baseline_chain_has_visible_static_intensities():
    """Baseline effects should have non-zero base intensity so the look is
    visible even before any modulation kicks in. Thresholds track the new
    'louder defaults' floor (Round 2)."""
    bundle = _bundle(has_stems=True)
    chain, _patches = generate_auto_modulation(bundle)

    by_name = {e.name: e for e in chain}
    assert by_name["vignette"].base_params["intensity"] > 0.4
    assert by_name["grain"].base_params["intensity"] > 0.15
    assert by_name["contrast_pump"].base_params["intensity"] > 0.25
    assert by_name["contrast_pump"].base_params["saturation"] > 0.5
    assert by_name["bloom"].base_params["intensity"] > 0.10
    assert by_name["light_leak"].base_params["intensity"] > 0.05


def test_patches_only_target_enabled_effects():
    """Auto-routed patches must not point at effects we left disabled."""
    bundle = _bundle(has_stems=True)
    chain, patches = generate_auto_modulation(bundle)
    enabled = {e.name for e in chain if e.enabled}

    for patch in patches:
        effect = patch.target.split(".", 1)[0]
        assert effect in enabled, (
            f"patch {patch.source}->{patch.target} targets disabled effect {effect}"
        )
        assert effect not in DESTRUCTIVE_EFFECTS, (
            f"patch {patch.source}->{patch.target} targets a destructive effect"
        )


def test_rhythmic_punches_only_appear_when_their_sources_exist():
    bundle = _bundle(has_stems=True)
    _chain, patches = generate_auto_modulation(bundle)

    sources = {p.source for p in patches}
    assert "downbeat" in sources
    assert "drop_detected" in sources
    assert "section_change" in sources
    # Continuous stem-driven modulation
    assert "bass_rms" in sources
    assert "drums_rms" in sources


def test_auto_modulation_without_stems_falls_back_to_fullmix():
    bundle = _bundle(has_stems=False)
    chain, patches = generate_auto_modulation(bundle)

    enabled = {e.name for e in chain if e.enabled}
    assert "bloom" in enabled

    sources = {p.source for p in patches}
    assert "bass_energy" in sources
    assert "bass_rms" not in sources


def test_no_patch_has_unbounded_scale_max():
    """Sanity check: no patch should produce values > 1.0 — bake clamps anyway,
    but visible-but-not-destructive scale_max upper bound is 0.95."""
    bundle = _bundle(has_stems=True)
    _chain, patches = generate_auto_modulation(bundle)
    for patch in patches:
        assert patch.scale_max <= 0.95, f"{patch.target} has scale_max {patch.scale_max}"


def test_sectional_patches_are_gated_by_section_mask():
    """Every section-specific patch should have a section_mask; global
    patches (drops, section changes) should not."""
    bundle = _bundle(has_stems=True)
    _chain, patches = generate_auto_modulation(bundle)

    # At least a handful of section-masked patches exist.
    masked = [p for p in patches if p.section_mask]
    assert len(masked) >= 4

    # Global patches only target drop_detected / section_change.
    for p in patches:
        if p.section_mask is None:
            assert p.source in ("drop_detected", "section_change"), (
                f"patch {p.source}->{p.target} has no section_mask "
                "but isn't a global source"
            )


def test_bake_respects_section_mask():
    """A patch with section_mask=[0] should have zero output outside section 0."""
    from backend.app.project.models import Patch
    from backend.app.routing.matrix import bake

    bundle = _bundle(has_stems=True)
    # Patch targeting chorus-only (section 2 in our fixture).
    patch = Patch(
        id="t1",
        source="rms",
        target="zoom.intensity",
        enabled=True,
        smooth_ms=0.0,
        scale_min=0.0,
        scale_max=1.0,
        section_mask=[2],
    )
    baked = bake(bundle, [patch])
    arr = baked.targets.get("zoom.intensity")
    assert arr is not None

    # Section 2 is [8.0, 12.0]s in the fixture; everything outside must be 0.
    rate = bundle.rate_hz
    lo = int(8.0 * rate)
    hi = int(12.0 * rate)
    assert float(arr[:lo].max()) == 0.0, "pre-section content leaked"
    assert float(arr[hi:].max()) == 0.0, "post-section content leaked"
    # And inside the section, the value should follow the source (non-zero).
    assert float(arr[lo:hi].max()) > 0.1, "gated patch silent inside its section"
