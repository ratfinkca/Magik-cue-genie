import importlib.util
import json
import subprocess
import sys
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "summarize_review_feedback.py"


def test_summarize_review_feedback_counts_fixture_data():
    module = _load_summary_module()
    summary = module.summarize_feedback(_feedback_fixture())
    text = module.format_summary(summary)

    assert summary["total_tracks"] == 2
    assert summary["total_reviewed_cues"] == 4
    assert summary["rating_counts"] == {
        "early": 1,
        "good": 1,
        "late": 1,
        "maybe": 1,
    }
    assert summary["label_rating_counts"] == {
        "energy_shift": {"maybe": 1},
        "intro": {"early": 1, "good": 1},
        "outro": {"late": 1},
    }
    assert summary["reference_bpm_count"] == 1
    assert summary["reference_key_count"] == 1
    assert "track-a.wav:" in text
    assert "intro @ 0:00.500: early - cue lands before audible start" in text
    assert "energy_shift @ 0:16.000: maybe" in text
    assert "Reference BPM coverage: 1/2" in text
    assert "Reference key coverage: 1/2" in text


def test_summarize_review_feedback_script_prints_summary(tmp_path):
    feedback_path = tmp_path / "magik-cue-genie-review-feedback.json"
    feedback_path.write_text(json.dumps(_feedback_fixture()), encoding="utf-8")

    result = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), str(feedback_path)],
        check=True,
        capture_output=True,
        text=True,
    )

    assert "Magik-cue-genie review feedback summary" in result.stdout
    assert "Total tracks: 2" in result.stdout
    assert "intro: early 1, good 1" in result.stdout
    assert "early 1, good 1, late 1, maybe 1" in result.stdout


def _load_summary_module():
    spec = importlib.util.spec_from_file_location("summarize_review_feedback", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _feedback_fixture():
    return {
        "metadata": {
            "analysis_profile": "balanced",
            "generated_at": "2026-06-03T00:00:00Z",
            "schema_version": 1,
        },
        "tracks": [
            {
                "source_file": "track-a.wav",
                "reference_bpm": "120.0",
                "reference_key": "8A",
                "reference_source": "",
                "reviewer_notes": "good reference",
                "cue_feedback": [
                    {
                        "cue_label": "intro",
                        "cue_time_seconds": "0.5",
                        "cue_timestamp": "0:00.500",
                        "detected_confidence": "0.35",
                        "review_rating": "early",
                        "review_note": "cue lands before audible start",
                    },
                    {
                        "cue_label": "outro",
                        "cue_time_seconds": "120.0",
                        "cue_timestamp": "2:00.000",
                        "detected_confidence": "0.3",
                        "review_rating": "late",
                        "review_note": "",
                    },
                    {
                        "cue_label": "",
                        "cue_time_seconds": "",
                        "cue_timestamp": "",
                        "detected_confidence": "",
                        "review_rating": "wrong",
                        "review_note": "no-cue row should not count as reviewed cue",
                    },
                ],
            },
            {
                "source_file": "track-b.wav",
                "reference_bpm": "",
                "reference_key": "",
                "reference_source": "",
                "reviewer_notes": "",
                "cue_feedback": [
                    {
                        "cue_label": "intro",
                        "cue_time_seconds": "0.0",
                        "cue_timestamp": "0:00.000",
                        "detected_confidence": "0.35",
                        "review_rating": "good",
                        "review_note": "",
                    },
                    {
                        "cue_label": "energy_shift",
                        "cue_time_seconds": "16.0",
                        "cue_timestamp": "0:16.000",
                        "detected_confidence": "0.25",
                        "review_rating": "maybe",
                        "review_note": "",
                    },
                ],
            },
        ],
    }
