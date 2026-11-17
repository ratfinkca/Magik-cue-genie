from __future__ import annotations

import json
from pathlib import Path

from .models import TrackSidecar


def sidecar_path_for(audio_path: Path, output_dir: Path) -> Path:
    return output_dir / f"{audio_path.stem}.magik-cue-genie.json"


def write_sidecar(sidecar: TrackSidecar, path: Path) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite existing sidecar: {path}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(sidecar.to_dict(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
