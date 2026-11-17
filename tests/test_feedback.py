from magik_cue_genie.feedback import (
    build_feedback_lookup,
    feedback_rating_counts,
    find_matching_cue_feedback,
)


def test_build_feedback_lookup_matches_by_basename_case_insensitive():
    lookup = build_feedback_lookup(
        {
            "tracks": [
                {
                    "source_file": "C:/Music/Track One.WAV",
                    "cue_feedback": [],
                }
            ]
        }
    )

    assert lookup["track one.wav"]["source_file"] == "C:/Music/Track One.WAV"


def test_find_matching_cue_feedback_uses_label_and_time_tolerance():
    track_feedback = {
        "cue_feedback": [
            {
                "cue_label": "intro",
                "cue_time_seconds": "0.505",
                "review_rating": "early",
                "review_note": "starts too soon",
            },
            {
                "cue_label": "outro",
                "cue_time_seconds": "0.505",
                "review_rating": "late",
                "review_note": "wrong label should not match",
            },
        ]
    }

    match = find_matching_cue_feedback(
        {"label": "intro", "time_seconds": 0.5},
        track_feedback,
        tolerance_seconds=0.01,
    )
    no_match = find_matching_cue_feedback(
        {"label": "intro", "time_seconds": 0.5},
        track_feedback,
        tolerance_seconds=0.001,
    )

    assert match is not None
    assert match["review_rating"] == "early"
    assert no_match is None


def test_feedback_rating_counts_includes_blank_bucket():
    counts = feedback_rating_counts(
        {
            "cue_feedback": [
                {"review_rating": "good"},
                {"review_rating": "early"},
                {"review_rating": ""},
                {},
            ]
        }
    )

    assert counts == {
        "good": 1,
        "early": 1,
        "late": 0,
        "wrong": 0,
        "maybe": 0,
        "blank": 2,
    }
