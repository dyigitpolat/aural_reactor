from __future__ import annotations

from collections import defaultdict

import orjson
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, set[WebSocket]] = defaultdict(set)

    async def join(self, project_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.rooms[project_id].add(ws)

    def leave(self, project_id: str, ws: WebSocket) -> None:
        self.rooms[project_id].discard(ws)
        if not self.rooms[project_id]:
            self.rooms.pop(project_id, None)

    async def broadcast(self, project_id: str, payload: dict) -> None:
        data = orjson.dumps(payload).decode()
        dead: list[WebSocket] = []
        for ws in list(self.rooms.get(project_id, [])):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.leave(project_id, ws)


hub = Hub()


@router.websocket("/project/{project_id}")
async def project_socket(ws: WebSocket, project_id: str) -> None:
    await hub.join(project_id, ws)
    try:
        await ws.send_text(orjson.dumps({"type": "hello", "project_id": project_id}).decode())
        while True:
            msg = await ws.receive_text()
            try:
                payload = orjson.loads(msg)
            except Exception:
                continue
            # Echo for now. Phase 4 routes patch edits here.
            await hub.broadcast(project_id, {"type": "echo", "data": payload})
    except WebSocketDisconnect:
        hub.leave(project_id, ws)
