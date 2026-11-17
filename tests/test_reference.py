from magik_cue_genie.reference import load_reference_csv


def test_load_reference_csv_parses_and_matches_by_basename_case_insensitive(tmp_path):
    reference_csv = tmp_path / "reference.csv"
    reference_csv.write_text(
        "source_file,reference_bpm,reference_key,notes\n"
        "C:/Music/Track One.WAV,124.5,8A,known library value\n"
        "track two.mp3,,Gm,\n",
        encoding="utf-8",
    )

    references = load_reference_csv(reference_csv)

    assert references["track one.wav"] == {
        "bpm": 124.5,
        "key": "8A",
        "notes": "known library value",
    }
    assert references["track two.mp3"] == {
        "bpm": None,
        "key": "Gm",
        "notes": None,
    }
