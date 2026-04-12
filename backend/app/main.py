import warnings
from contextlib import asynccontextmanager

# librosa lazily imports audioread, whose `import aifc` emits a Python 3.12
# DeprecationWarning. We never use audioread at runtime (ingest normalizes
# everything to FLAC, which soundfile reads natively), so silence the noise
# at the app boundary before any module that pulls librosa is imported.
warnings.filterwarnings(
    "ignore",
    message=r"'(aifc|audioop|sunau)' is deprecated.*",
    category=DeprecationWarning,
)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.app.api import analyze, arrange, effects, media, projects, render, routing
from backend.app.config import settings
from backend.app.ws import project_ws


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.ensure_dirs()
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Music Video Maker",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.mount("/media", StaticFiles(directory=str(settings.media_dir)), name="media")

    app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
    app.include_router(media.router, prefix="/api/media", tags=["media"])
    app.include_router(analyze.router, prefix="/api/analyze", tags=["analyze"])
    app.include_router(arrange.router, prefix="/api/arrange", tags=["arrange"])
    app.include_router(effects.router, prefix="/api/effects", tags=["effects"])
    app.include_router(routing.router, prefix="/api/routing", tags=["routing"])
    app.include_router(render.router, prefix="/api/render", tags=["render"])
    app.include_router(project_ws.router, prefix="/ws", tags=["ws"])

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
