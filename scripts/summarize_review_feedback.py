from __future__ import annotations

from collections import Counter, defaultdict
import argparse
import json
from pathlib import Path
from typing import Any


IMPORTANT_RATINGS = {"wrong", "early", "late", "maybe"}


def summarize_feedback(data: dict[str, Any]) -> dict[str, Any]:
    tracks = data.get("tracks") or []
    rating_counts: Counter[str] = Counter()
    label_rating_counts: dict[str, Counter[str]] = defaultdict(Counter)
    notable_by_track: dict[str, list[dict[str, str]]] = defaultdict(list)
    reference_bpm_count = 0
    reference_key_count = 0
    reviewed_cue_count = 0

    for track in tracks:
        source_file = str(track.get("source_file") or "Unknown")
        if _has_value(track.get("reference_bpm")):
            reference_bpm_count += 1
        if _has_value(track.get("reference_key")):
            reference_key_count += 1

        for cue in track.get("cue_feedback") or []:
            label = str(cue.get("cue_label") or "").strip()
            if not label:
                continue

            reviewed_cue_count += 1
            rating = str(cue.get("review_rating") or "blank").strip() or "blank"
            timestamp = str(cue.get("cue_timestamp") or "")
            note = str(cue.get("review_note") or "")
            rating_counts[rating] += 1
            label_rating_counts[label][rating] += 1
            if rating in IMPORTANT_RATINGS:
                notable_by_track[source_file].append(
                    {
                        "label": label,
                        "timestamp": timestamp,
                        "rating": rating,
                        "note": note,
                    }
                )

    return {
        "total_tracks": len(tracks),
        "total_reviewed_cues": reviewed_cue_count,
        "rating_counts": dict(sorted(rating_counts.items())),
        "label_rating_counts": {
            label: dict(sorted(counts.items())) for label, counts in sorted(label_rating_counts.items())
        },
        "notable_by_track": dict(sorted(notable_by_track.items())),
        "reference_bpm_count": reference_bpm_count,
        "reference_key_count": reference_key_count,
    }


def format_summary(summary: dict[str, Any]) -> str:
    lines = [
        "Magik-cue-genie review feedback summary",
        f"Total tracks: {summary['total_tracks']}",
        f"Total reviewed cues: {summary['total_reviewed_cues']}",
        "",
        "Counts by label and rating:",
    ]

    label_rating_counts = summary["label_rating_counts"]
    if label_rating_counts:
        for label, counts in label_rating_counts.items():
            lines.append(f"  {label}: {_format_counts(counts)}")
    else:
        lines.append("  None")

    lines.extend(["", "Counts by rating overall:"])
    rating_counts = summary["rating_counts"]
    if rating_counts:
        lines.append(f"  {_format_counts(rating_counts)}")
    else:
        lines.append("  None")

    lines.extend(["", "Cues rated wrong/early/late/maybe:"])
    notable_by_track = summary["notable_by_track"]
    if notable_by_track:
        for source_file, cues in notable_by_track.items():
            lines.append(f"  {source_file}:")
            for cue in cues:
                note = f" - {cue['note']}" if cue["note"] else ""
                lines.append(f"    {cue['label']} @ {cue['timestamp']}: {cue['rating']}{note}")
    else:
        lines.append("  None")

    lines.extend(
        [
            "",
            f"Reference BPM coverage: {summary['reference_bpm_count']}/{summary['total_tracks']}",
            f"Reference key coverage: {summary['reference_key_count']}/{summary['total_tracks']}",
        ]
    )
    return "\n".join(lines)


def load_feedback(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize magik-cue-genie review feedback JSON.")
    parser.add_argument("feedback_json", type=Path, help="Downloaded magik-cue-genie-review-feedback.json file.")
    args = parser.parse_args()

    data = load_feedback(args.feedback_json)
    print(format_summary(summarize_feedback(data)))


def _format_counts(counts: dict[str, int]) -> str:
    return ", ".join(f"{key} {value}" for key, value in counts.items())


def _has_value(value: Any) -> bool:
    return value is not None and str(value).strip() != ""


if __name__ == "__main__":
    main()
