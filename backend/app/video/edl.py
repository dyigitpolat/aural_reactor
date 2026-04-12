"""Edit Decision List data model + export helpers."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from backend.app.project.models import Cut


@dataclass
class EDL:
    fps: float
    duration: float
    cuts: list[Cut]

    def to_project_cuts(self) -> list[Cut]:
        return list(self.cuts)

    def to_fcpxml(self, out_path: Path, clip_paths: dict[str, Path]) -> None:
        """Minimal FCPXML v1.10 export so power users can open in DaVinci/Premiere."""
        fcpxml = ET.Element("fcpxml", version="1.10")
        resources = ET.SubElement(fcpxml, "resources")
        fmt_id = "r0"
        ET.SubElement(
            resources,
            "format",
            id=fmt_id,
            name=f"FFVideoFormat{int(self.fps)}p",
            frameDuration=f"1/{int(self.fps)}s",
        )
        asset_ids: dict[str, str] = {}
        for idx, (cid, path) in enumerate(clip_paths.items(), start=1):
            asset_id = f"r{idx}"
            asset_ids[cid] = asset_id
            ET.SubElement(
                resources, "asset",
                id=asset_id, name=path.stem, src=path.resolve().as_uri(),
                hasVideo="1", format=fmt_id,
            )

        library = ET.SubElement(fcpxml, "library")
        event = ET.SubElement(library, "event", name="MVM")
        project = ET.SubElement(event, "project", name="MVM Edit")
        sequence = ET.SubElement(
            project, "sequence", format=fmt_id, duration=f"{int(self.duration * self.fps)}/{int(self.fps)}s"
        )
        spine = ET.SubElement(sequence, "spine")

        for cut in self.cuts:
            asset_id = asset_ids.get(cut.clip_id)
            if asset_id is None:
                continue
            start_frames = int(round(cut.t_start * self.fps))
            dur_frames = int(round((cut.t_end - cut.t_start) * self.fps))
            in_frames = int(round(cut.in_point * self.fps))
            ET.SubElement(
                spine, "asset-clip",
                ref=asset_id,
                offset=f"{start_frames}/{int(self.fps)}s",
                duration=f"{dur_frames}/{int(self.fps)}s",
                start=f"{in_frames}/{int(self.fps)}s",
            )

        tree = ET.ElementTree(fcpxml)
        ET.indent(tree, space="  ")
        tree.write(out_path, encoding="utf-8", xml_declaration=True)
