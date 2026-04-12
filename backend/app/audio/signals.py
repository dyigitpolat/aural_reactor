from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import orjson


# Canonical names so UI, routing, and pipeline all agree.
CONTINUOUS_SIGNALS: tuple[str, ...] = (
    "rms",
    "bass_energy",
    "mid_energy",
    "treble_energy",
    "spectral_centroid",
    "spectral_flux",
    "harmonicity",
    "percussiveness",
    "drums_rms",
    "bass_rms",
    "vocals_rms",
    "other_rms",
    "tempo",
)

DISCRETE_TRIGGERS: tuple[str, ...] = (
    "beat",
    "downbeat",
    "bar_start",
    "section_change",
    "drop_detected",
)


@dataclass
class Section:
    start: float
    end: float
    label: str
    energy: float  # 0..1 mean RMS within section


@dataclass
class SignalBundle:
    """All analysis results for one audio file.

    Continuous arrays are sampled at `rate_hz` (default 100 Hz) over duration.
    Discrete events are lists of seconds.
    """

    duration: float
    sr: int
    rate_hz: float
    tempo_bpm: float

    continuous: dict[str, np.ndarray] = field(default_factory=dict)
    events: dict[str, list[float]] = field(default_factory=dict)

    beat_times: list[float] = field(default_factory=list)
    downbeat_times: list[float] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)

    has_stems: bool = False

    @property
    def n_frames(self) -> int:
        return int(round(self.duration * self.rate_hz))

    def time_axis(self) -> np.ndarray:
        return np.arange(self.n_frames) / self.rate_hz

    def sample(self, name: str, t: float) -> float:
        """Sample a continuous signal at time t (seconds), with clipping."""
        arr = self.continuous.get(name)
        if arr is None or arr.size == 0:
            return 0.0
        idx = int(round(t * self.rate_hz))
        if idx < 0:
            idx = 0
        elif idx >= arr.size:
            idx = arr.size - 1
        return float(arr[idx])

    def to_disk(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)

        arrs = {k: v.astype(np.float32) for k, v in self.continuous.items()}
        np.savez_compressed(directory / "continuous.npz", **arrs)

        manifest = {
            "duration": self.duration,
            "sr": self.sr,
            "rate_hz": self.rate_hz,
            "tempo_bpm": self.tempo_bpm,
            "has_stems": self.has_stems,
            "events": self.events,
            "beat_times": self.beat_times,
            "downbeat_times": self.downbeat_times,
            "sections": [
                {"start": s.start, "end": s.end, "label": s.label, "energy": s.energy}
                for s in self.sections
            ],
        }
        (directory / "manifest.json").write_bytes(
            orjson.dumps(manifest, option=orjson.OPT_INDENT_2)
        )

    @classmethod
    def from_disk(cls, directory: Path) -> "SignalBundle":
        manifest = orjson.loads((directory / "manifest.json").read_bytes())
        npz = np.load(directory / "continuous.npz")
        continuous = {k: npz[k] for k in npz.files}
        bundle = cls(
            duration=manifest["duration"],
            sr=manifest["sr"],
            rate_hz=manifest["rate_hz"],
            tempo_bpm=manifest["tempo_bpm"],
            continuous=continuous,
            events=manifest["events"],
            beat_times=manifest["beat_times"],
            downbeat_times=manifest["downbeat_times"],
            has_stems=manifest["has_stems"],
        )
        bundle.sections = [Section(**s) for s in manifest["sections"]]
        return bundle

    def summary(self) -> dict:
        """Lightweight JSON for the UI (no raw continuous arrays)."""
        return {
            "duration": self.duration,
            "sr": self.sr,
            "rate_hz": self.rate_hz,
            "tempo_bpm": self.tempo_bpm,
            "has_stems": self.has_stems,
            "continuous_keys": sorted(self.continuous.keys()),
            "event_keys": sorted(self.events.keys()),
            "beat_count": len(self.beat_times),
            "downbeat_count": len(self.downbeat_times),
            "section_count": len(self.sections),
            "beat_times": self.beat_times,
            "downbeat_times": self.downbeat_times,
            "events": {k: list(v) for k, v in self.events.items()},
            "sections": [
                {"start": s.start, "end": s.end, "label": s.label, "energy": s.energy}
                for s in self.sections
            ],
        }
