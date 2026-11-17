from __future__ import annotations

import csv
from pathlib import Path
from typing import Any


def load_reference_csv(path: Path) -> dict[str, dict[str, Any]]:
    references: dict[str, dict[str, Any]] = {}
    with path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            source_file = (row.get("source_file") or "").strip()
            if not source_file:
                continue

            references[Path(source_file).name.lower()] = {
                "bpm": _parse_optional_float(row.get("reference_bpm")),
                "key": _parse_optional_text(row.get("reference_key")),
                "notes": _parse_optional_text(row.get("notes")),
            }
    return references


def _parse_optional_float(value: str | None) -> float | None:
    text = (value or "").strip()
    if not text:
        return None
    return float(text)


def _parse_optional_text(value: str | None) -> str | None:
    text = (value or "").strip()
    return text or None
