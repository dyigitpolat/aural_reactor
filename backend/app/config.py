from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MVM_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8765

    root_dir: Path = Path(__file__).resolve().parents[2]
    storage_dir: Path = root_dir / "storage"
    media_dir: Path = storage_dir / "media"
    cache_dir: Path = storage_dir / "cache"
    renders_dir: Path = storage_dir / "renders"
    projects_dir: Path = storage_dir / "projects"
    shaders_dir: Path = root_dir / "shared" / "shaders"

    analysis_sr: int = 22050
    analysis_hop: int = 512
    signal_rate_hz: float = 100.0

    enable_stems: bool = True

    def ensure_dirs(self) -> None:
        for p in (self.media_dir, self.cache_dir, self.renders_dir, self.projects_dir):
            p.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()
