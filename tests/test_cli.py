import json

from typer.testing import CliRunner

from magik_cue_genie.analysis import AnalysisSettings, get_analysis_settings_profile
from magik_cue_genie.cli import app
from conftest import write_segmented_wav, write_silent_wav, write_tone_wav


runner = CliRunner()


def test_cli_processes_single_synthetic_wav(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    sidecar_path = output_dir / "tone.magik-cue-genie.json"
    assert sidecar_path.exists()
    assert (output_dir / "report.html").exists()
    assert (output_dir / "report.json").exists()


def test_cli_extracts_mono_wav_duration(tmp_path):
    audio_path = tmp_path / "mono.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, channels=1, duration_seconds=0.25, frame_rate=8_000)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    data = json.loads((output_dir / "mono.magik-cue-genie.json").read_text(encoding="utf-8"))
    assert data["analysis"]["duration_seconds"] == 0.25
    assert data["analysis"]["energy_summary"]["max_rms"] == 0.0


def test_cli_extracts_stereo_wav_duration(tmp_path):
    audio_path = tmp_path / "stereo.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, channels=2, duration_seconds=0.5, frame_rate=44_100)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    data = json.loads((output_dir / "stereo.magik-cue-genie.json").read_text(encoding="utf-8"))
    assert data["analysis"]["duration_seconds"] == 0.5
    assert data["analysis"]["energy_summary"]["max_rms"] == 0.0


def test_silent_wav_has_near_zero_energy(tmp_path):
    audio_path = tmp_path / "silence.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.5)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    data = json.loads((output_dir / "silence.magik-cue-genie.json").read_text(encoding="utf-8"))
    energy = data["analysis"]["energy_summary"]
    assert energy["window_size_seconds"] == 0.25
    assert energy["max_rms"] == 0.0
    assert energy["mean_rms"] == 0.0
    assert energy["normalized_envelope"] == [0.0, 0.0]
    assert data["cues"] == []


def test_louder_tone_has_higher_rms_than_quieter_tone(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    write_tone_wav(input_dir / "quiet.wav", amplitude=0.1, duration_seconds=0.5)
    write_tone_wav(input_dir / "loud.wav", amplitude=0.6, duration_seconds=0.5)

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    quiet = json.loads((output_dir / "quiet.magik-cue-genie.json").read_text(encoding="utf-8"))
    loud = json.loads((output_dir / "loud.magik-cue-genie.json").read_text(encoding="utf-8"))
    assert loud["analysis"]["energy_summary"]["max_rms"] > quiet["analysis"]["energy_summary"]["max_rms"]
    assert loud["analysis"]["energy_summary"]["mean_rms"] > quiet["analysis"]["energy_summary"]["mean_rms"]


def test_stereo_tone_energy_summary_works(tmp_path):
    audio_path = tmp_path / "stereo-tone.wav"
    output_dir = tmp_path / "out"
    write_tone_wav(audio_path, channels=2, amplitude=0.4, duration_seconds=0.5)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    data = json.loads((output_dir / "stereo-tone.magik-cue-genie.json").read_text(encoding="utf-8"))
    energy = data["analysis"]["energy_summary"]
    assert energy["max_rms"] > 0.0
    assert energy["mean_rms"] > 0.0
    assert len(energy["normalized_envelope"]) == 2


def test_cli_processes_directory_with_multiple_supported_files(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    write_silent_wav(input_dir / "one.wav", duration_seconds=0.1)
    write_silent_wav(input_dir / "two.WAV", duration_seconds=0.2)
    (input_dir / "three.flac").write_bytes(b"placeholder only")

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert "ffmpeg" in result.output
    assert sorted(path.name for path in output_dir.glob("*.magik-cue-genie.json")) == [
        "one.magik-cue-genie.json",
        "three.magik-cue-genie.json",
        "two.magik-cue-genie.json",
    ]
    one = json.loads((output_dir / "one.magik-cue-genie.json").read_text(encoding="utf-8"))
    two = json.loads((output_dir / "two.magik-cue-genie.json").read_text(encoding="utf-8"))
    three = json.loads((output_dir / "three.magik-cue-genie.json").read_text(encoding="utf-8"))
    assert one["analysis"]["duration_seconds"] == 0.1
    assert two["analysis"]["duration_seconds"] == 0.2
    assert three["analysis"]["duration_seconds"] is None
    assert one["analysis"]["energy_summary"] is not None
    assert two["analysis"]["energy_summary"] is not None
    assert three["analysis"]["energy_summary"] is None
    assert one["warnings"] == []
    assert two["warnings"] == []
    assert len(three["warnings"]) == 1
    assert "ffmpeg" in three["warnings"][0]
    assert "duration, energy, and cue detection are unavailable" in three["warnings"][0]


def test_report_displays_track_warnings(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    (input_dir / "placeholder.mp3").write_bytes(b"placeholder only")

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    report = (output_dir / "report.html").read_text(encoding="utf-8")
    assert "Track Warnings" in report
    assert "ffmpeg" in report
    assert "duration, energy, and cue detection are unavailable" in report


def test_unsupported_files_are_warned_and_skipped(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    write_silent_wav(input_dir / "tone.wav", duration_seconds=0.1)
    unsupported = input_dir / "notes.txt"
    unsupported.write_text("not audio", encoding="utf-8")

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert "Skipped notes.txt: Unsupported file extension (.txt)" in result.output
    assert "notes.txt" in result.output
    assert not (output_dir / "notes.magik-cue-genie.json").exists()


def test_unsupported_extension_appears_in_skipped_files_report(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    (input_dir / "notes.txt").write_text("not audio", encoding="utf-8")

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    report = (output_dir / "report.html").read_text(encoding="utf-8")
    assert "Skipped files" in report
    assert "notes.txt" in report
    assert "Unsupported file extension" in report
    assert ".txt" in report
    assert not list(output_dir.glob("*.magik-cue-genie.json"))
    assert (output_dir / "report.json").exists()


def test_source_files_are_not_modified(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)
    original_bytes = audio_path.read_bytes()
    original_stat = audio_path.stat()

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert audio_path.read_bytes() == original_bytes
    assert audio_path.stat().st_size == original_stat.st_size
    assert audio_path.stat().st_mtime_ns == original_stat.st_mtime_ns


def test_cli_sidecar_shape_matches_spec(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    data = json.loads((output_dir / "tone.magik-cue-genie.json").read_text(encoding="utf-8"))
    assert set(data) == {"schema_version", "source_file", "analysis", "cues", "warnings"}
    assert data["schema_version"] == 1
    assert data["source_file"] == "tone.wav"
    assert data["analysis"] == {
        "duration_seconds": 0.1,
        "estimated_bpm": None,
        "estimated_bpm_confidence": None,
        "estimated_bpm_source": None,
        "bpm_debug": {
            "source": "rms_onset_interval",
            "status": "rejected",
            "onset_times_seconds": [],
            "intervals_seconds": [],
            "candidate_bpms": [],
            "selected_bpm": None,
            "confidence": None,
            "reason": "Not enough RMS windows for BPM estimation.",
        },
        "estimated_key": None,
        "energy_summary": {
            "window_size_seconds": 0.25,
            "max_rms": 0.0,
            "mean_rms": 0.0,
            "normalized_envelope": [0.0],
        },
    }
    assert data["cues"] == []
    assert data["warnings"] == []
    assert "beat_debug" not in data["analysis"]
    assert "tempo_candidates_debug" not in data["analysis"]
    assert "onset_times_seconds" not in data["analysis"]
    assert "local_peak_times_seconds" not in data["analysis"]


def test_wav_with_unavailable_energy_gets_warning(tmp_path):
    audio_path = tmp_path / "empty.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.0)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    data = json.loads((output_dir / "empty.magik-cue-genie.json").read_text(encoding="utf-8"))
    assert data["cues"] == []
    assert data["warnings"] == ["Cue detection skipped because energy envelope data is unavailable."]
    assert "Cue detection skipped because energy envelope data is unavailable." in (
        output_dir / "report.html"
    ).read_text(encoding="utf-8")


def test_malformed_wav_is_reported_without_crashing(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    write_silent_wav(input_dir / "good.wav", duration_seconds=0.1)
    (input_dir / "broken.wav").write_bytes(b"not a real wave file")

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert "Skipped broken.wav: Malformed WAV file" in result.output
    assert (output_dir / "good.magik-cue-genie.json").exists()
    assert not (output_dir / "broken.magik-cue-genie.json").exists()
    report = (output_dir / "report.html").read_text(encoding="utf-8")
    assert "Skipped files" in report
    assert "broken.wav" in report
    assert "Malformed WAV file" in report


def test_report_includes_analyzed_tracks_and_skipped_files_separately(tmp_path):
    input_dir = tmp_path / "music"
    output_dir = tmp_path / "out"
    input_dir.mkdir()
    write_silent_wav(input_dir / "good.wav", duration_seconds=0.1)
    (input_dir / "notes.txt").write_text("not audio", encoding="utf-8")

    result = runner.invoke(app, ["analyze", str(input_dir), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert (output_dir / "good.magik-cue-genie.json").exists()
    report = (output_dir / "report.html").read_text(encoding="utf-8")
    assert "<h2>Tracks</h2>" in report
    assert "good.wav" in report
    assert "good.magik-cue-genie.json" in report
    assert "<h2>Skipped files</h2>" in report
    assert "notes.txt" in report
    assert "notes.magik-cue-genie.json" not in report
    report_json = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    assert report_json["summary"]["analyzed_count"] == 1
    assert report_json["summary"]["skipped_count"] == 1


def test_report_json_is_created(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert (output_dir / "report.json").exists()


def test_default_cli_profile_equals_balanced_settings(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    assert report["analysis_profile"] == "balanced"
    assert report["analysis_settings"] == AnalysisSettings().to_dict()


def test_profile_option_changes_report_json_analysis_settings(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir), "--profile", "sensitive"])

    assert result.exit_code == 0, result.output
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    assert report["analysis_profile"] == "sensitive"
    assert report["analysis_settings"] == get_analysis_settings_profile("sensitive").to_dict()


def test_conservative_profile_writes_selected_profile_name(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir), "--profile", "conservative"])

    assert result.exit_code == 0, result.output
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    assert report["analysis_profile"] == "conservative"
    assert report["analysis_settings"] == get_analysis_settings_profile("conservative").to_dict()


def test_invalid_profile_is_rejected_cleanly(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir), "--profile", "wild"])

    assert result.exit_code != 0
    assert "Invalid value" in result.output or "invalid choice" in result.output.lower()


def test_valid_wav_sidecar_still_exists_with_report_json(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    assert (output_dir / "tone.magik-cue-genie.json").exists()
    assert (output_dir / "report.json").exists()


def test_cli_reference_csv_adds_report_metadata_without_changing_sidecar(tmp_path):
    audio_path = tmp_path / "Tone.WAV"
    output_dir = tmp_path / "out"
    reference_csv = tmp_path / "reference.csv"
    write_silent_wav(audio_path, duration_seconds=0.1)
    reference_csv.write_text(
        "source_file,reference_bpm,reference_key,notes\n"
        "tone.wav,120.0,8A,manual reference\n",
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        [
            "analyze",
            str(audio_path),
            "--output",
            str(output_dir),
            "--reference-csv",
            str(reference_csv),
        ],
    )

    assert result.exit_code == 0, result.output
    sidecar = json.loads((output_dir / "Tone.magik-cue-genie.json").read_text(encoding="utf-8"))
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    html = (output_dir / "report.html").read_text(encoding="utf-8")
    assert "reference" not in sidecar
    assert report["analyzed_tracks"][0]["reference"] == {
        "bpm": 120.0,
        "key": "8A",
        "notes": "manual reference",
    }
    assert "Reference BPM</dt><dd>120.0" in html
    assert "Reference Key</dt><dd>8A" in html
    assert "manual reference" in html


def test_cli_without_reference_csv_preserves_report_track_shape(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    write_silent_wav(audio_path, duration_seconds=0.1)

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    assert "reference" not in report["analyzed_tracks"][0]


def test_cli_feedback_json_adds_html_overlay_without_changing_json_outputs(tmp_path):
    audio_path = tmp_path / "tone.wav"
    output_dir = tmp_path / "out"
    feedback_json = tmp_path / "magik-cue-genie-review-feedback.json"
    write_silent_wav(audio_path, duration_seconds=0.1)
    feedback_json.write_text(
        json.dumps(
            {
                "metadata": {"schema_version": 1},
                "tracks": [
                    {
                        "source_file": "TONE.WAV",
                        "reference_bpm": "120.0",
                        "reference_key": "8A",
                        "reference_source": "manual notes",
                        "cue_feedback": [
                            {
                                "cue_label": "intro",
                                "cue_time_seconds": "0.5",
                                "cue_timestamp": "0:00.500",
                                "detected_confidence": "0.35",
                                "review_rating": "wrong",
                                "review_note": "fixture note",
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    result = runner.invoke(
        app,
        [
            "analyze",
            str(audio_path),
            "--output",
            str(output_dir),
            "--feedback-json",
            str(feedback_json),
        ],
    )

    assert result.exit_code == 0, result.output
    sidecar = json.loads((output_dir / "tone.magik-cue-genie.json").read_text(encoding="utf-8"))
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    html = (output_dir / "report.html").read_text(encoding="utf-8")
    assert set(sidecar) == {"schema_version", "source_file", "analysis", "cues", "warnings"}
    assert "previous_feedback" not in report
    assert "Previous review" in html
    assert "Reference comparison" in html
    assert "Reference BPM</dt><dd>120.0" in html
    assert "Reference Key</dt><dd>8A" in html
    assert "Reference source</dt><dd>manual notes" in html
    assert "wrong 1" in html


def test_sidecar_and_report_json_include_cue_metadata_when_present(tmp_path):
    audio_path = tmp_path / "low-high.wav"
    output_dir = tmp_path / "out"
    write_segmented_wav(audio_path, [("tone", 2.0, 0.2), ("tone", 2.0, 0.8)])

    result = runner.invoke(app, ["analyze", str(audio_path), "--output", str(output_dir)])

    assert result.exit_code == 0, result.output
    sidecar = json.loads((output_dir / "low-high.magik-cue-genie.json").read_text(encoding="utf-8"))
    report = json.loads((output_dir / "report.json").read_text(encoding="utf-8"))
    sidecar_shift = next(cue for cue in sidecar["cues"] if cue["label"] == "energy_shift")
    report_shift = next(cue for cue in report["analyzed_tracks"][0]["cues"] if cue["label"] == "energy_shift")
    assert sidecar_shift["metadata"]["heuristic"] == "rms_energy_shift"
    assert sidecar_shift["metadata"]["direction"] == "rise"
    assert sidecar_shift["metadata"]["delta"] > 0
    assert "alignment_diagnostic" not in sidecar_shift
    assert "suggested_improvement" not in sidecar_shift
    assert report_shift["metadata"] == sidecar_shift["metadata"]
    assert "alignment_diagnostic" in report_shift
    assert "suggested_improvement" in report_shift
