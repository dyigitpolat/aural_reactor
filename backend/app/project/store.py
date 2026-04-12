from __future__ import annotations

import uuid
from datetime import UTC, datetime

import orjson

from backend.app.config import settings
from backend.app.project.models import Project


class ProjectStore:
    """JSON-on-disk persistence for projects. Single-user local tool."""

    def __init__(self) -> None:
        self.dir = settings.projects_dir

    def _path(self, project_id: str):
        return self.dir / f"{project_id}.json"

    def create(self, name: str) -> Project:
        project = Project(id=uuid.uuid4().hex[:12], name=name)
        self.save(project)
        return project

    def save(self, project: Project) -> None:
        project.updated_at = datetime.now(UTC)
        data = orjson.dumps(project.model_dump(mode="json"), option=orjson.OPT_INDENT_2)
        self._path(project.id).write_bytes(data)

    def load(self, project_id: str) -> Project | None:
        p = self._path(project_id)
        if not p.exists():
            return None
        return Project.model_validate(orjson.loads(p.read_bytes()))

    def list(self) -> list[Project]:
        out: list[Project] = []
        for f in sorted(self.dir.glob("*.json")):
            try:
                out.append(Project.model_validate(orjson.loads(f.read_bytes())))
            except Exception:
                continue
        return out

    def delete(self, project_id: str) -> bool:
        p = self._path(project_id)
        if p.exists():
            p.unlink()
            return True
        return False


store = ProjectStore()
