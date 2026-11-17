from __future__ import annotations

import json
from pathlib import Path
from typing import Any


RATING_VALUES = ("good", "early", "late", "wrong", "maybe", "blank")
DEFAULT_CUE_MATCH_TOLERANCE_SECONDS = 0.01


def load_feedback_json(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return build_feedback_lookup(data)


def build_feedback_lookup(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}
    for track in data.get("tracks") or []:
        source_file = str(track.get("source_file") or "").strip()
        if not source_file:
            continue
        lookup[Path(source_file).name.lower()] = track
    return lookup


def feedback_rating_counts(track_feedback: dict[str, Any]) -> dict[str, int]:
    counts = {rating: 0 for rating in RATING_VALUES}
    for cue_feedback in track_feedback.get("cue_feedback") or []:
        rating = str(cue_feedback.get("review_rating") or "").strip()
        if rating not in RATING_VALUES:
            rating = "blank"
        counts[rating] += 1
    return counts


def find_matching_cue_feedback(
    cue: dict[str, Any],
    track_feedback: dict[str, Any],
    tolerance_seconds: float = DEFAULT_CUE_MATCH_TOLERANCE_SECONDS,
) -> dict[str, Any] | None:
    cue_label = str(cue.get("label") or "")
    cue_time = _optional_float(cue.get("time_seconds"))
    if cue_time is None:
        return None

    for cue_feedback in track_feedback.get("cue_feedback") or []:
        feedback_label = str(cue_feedback.get("cue_label") or "")
        feedback_time = _optional_float(cue_feedback.get("cue_time_seconds"))
        if feedback_label != cue_label or feedback_time is None:
            continue
        if abs(feedback_time - cue_time) <= tolerance_seconds:
            return cue_feedback
    return None


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None
