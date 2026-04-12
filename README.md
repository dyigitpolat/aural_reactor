# Music Video Maker

Audio-reactive music video creation tool. Drop in an audio track plus a pile of video clips and the app auto-cuts and effects the clips in time with the music. Tune everything through a browser UI.

## Requirements

- **Python 3.12** (`python3.12` on PATH)
- **Node 20+** and **pnpm**
- **ffmpeg** on PATH — install with `brew install ffmpeg`

## Setup

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"           # core
.venv/bin/pip install -e ".[dev,stems]"     # +demucs/torch (optional, ~2GB)

cd frontend && pnpm install && cd ..
```

## Run

```bash
./scripts/dev.sh
```

Backend: http://127.0.0.1:8765 · Frontend: http://127.0.0.1:5173 · API docs: /docs

## Architecture

See [plan file](../../.claude/plans/precious-popping-scone.md) for the full design.

- `backend/app/audio/` — analysis pipeline (librosa beats/features, optional demucs stems, drop detector)
- `backend/app/video/` — clip probe, EDL arranger, effect registry
- `backend/app/routing/` — modulation matrix
- `backend/app/render/` — ModernGL headless render + ffmpeg mux
- `shared/shaders/` — GLSL effects shared between Python render and browser preview
- `frontend/src/` — React + Vite + Tailwind + PixiJS UI
