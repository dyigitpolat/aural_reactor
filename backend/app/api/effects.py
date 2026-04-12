from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from backend.app.video.effects import (
    EFFECT_BY_NAME,
    build_fragment,
    effect_order,
    effect_schema,
    load_common,
)

router = APIRouter()

# Shaders must never be cached by the browser. A stale shader from an earlier
# build of the template can re-create the exact "shader compile error 0:2"
# issue even after we fix the source — the browser keeps serving its cache
# until we explicitly forbid it.
_NO_CACHE = {"cache-control": "no-store, no-cache, must-revalidate, max-age=0"}


@router.get("")
async def list_effects() -> dict:
    return {
        "order": effect_order(),
        "effects": effect_schema(),
    }


@router.get("/common.glsl")
async def get_common() -> PlainTextResponse:
    return PlainTextResponse(load_common(), headers=_NO_CACHE)


@router.get("/{name}.frag")
async def get_effect_fragment(name: str, target: str = "webgl") -> PlainTextResponse:
    if name not in EFFECT_BY_NAME:
        raise HTTPException(404, f"unknown effect {name}")
    return PlainTextResponse(build_fragment(name, target), headers=_NO_CACHE)
