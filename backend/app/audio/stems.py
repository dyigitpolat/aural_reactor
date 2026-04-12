"""Demucs stem separation wrapper. Gracefully degrades to None if not installed."""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


def has_demucs() -> bool:
    try:
        import demucs.separate  # noqa: F401
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def separate_stems(
    audio_path: Path,
    out_dir: Path,
    sr: int = 22050,
) -> dict[str, np.ndarray] | None:
    """Run htdemucs on `audio_path`, return mono resampled stems at `sr`.

    Returns {"drums": y, "bass": y, "vocals": y, "other": y} or None if demucs
    is not installed. Results are also cached to `out_dir` as wav files.
    """
    if not has_demucs():
        log.info("demucs not installed; skipping stem separation")
        return None

    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        import soundfile as sf
        import torch
        from demucs.apply import apply_model
        from demucs.audio import AudioFile
        from demucs.pretrained import get_model
    except Exception as e:
        log.warning("demucs import failed: %s", e)
        return None

    expected = {name: out_dir / f"{name}.wav" for name in ("drums", "bass", "vocals", "other")}
    if all(p.exists() for p in expected.values()):
        return {name: _load_mono(p, sr) for name, p in expected.items()}

    try:
        model = get_model("htdemucs")
        model.eval()
        wav = AudioFile(str(audio_path)).read(
            streams=0, samplerate=model.samplerate, channels=model.audio_channels
        )
        ref = wav.mean(0)
        wav = (wav - ref.mean()) / ref.std().clamp(min=1e-8)
        with torch.no_grad():
            sources = apply_model(model, wav[None], device="cpu", progress=False)[0]
        sources = sources * ref.std() + ref.mean()

        name_order = model.sources  # typically ['drums', 'bass', 'other', 'vocals']
        result: dict[str, np.ndarray] = {}
        for name, src in zip(name_order, sources, strict=False):
            mono = src.mean(dim=0).cpu().numpy().astype(np.float32)
            sf.write(str(out_dir / f"{name}.wav"), mono, model.samplerate)
            import librosa
            if sr != model.samplerate:
                mono = librosa.resample(mono, orig_sr=model.samplerate, target_sr=sr)
            result[name] = mono
        return result
    except Exception as e:
        log.warning("demucs separation failed: %s", e)
        return None


def _load_mono(path: Path, sr: int) -> np.ndarray:
    import librosa
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y.astype(np.float32)
