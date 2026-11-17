from pathlib import Path

from magik_cue_genie.analysis import AnalysisProfile, AnalysisSettings
from magik_cue_genie.models import (
    AnalysisSummary,
    AnalyzeResult,
    CueSuggestion,
    EnergySummary,
    SkippedFile,
    TrackSidecar,
)
from magik_cue_genie.report import (
    _build_cue_alignment_diagnostic,
    _build_suggested_cue_improvement,
    _format_timestamp,
    build_report_data,
    render_report,
)
from magik_cue_genie.report import _cue_marker_position_percent, _render_energy_timeline


def test_build_report_data_produces_expected_top_level_shape():
    report_data = build_report_data(
        results=[_analyze_result()],
        skipped_files=[SkippedFile(source_file="notes.txt", reason="Unsupported file extension", detail=".txt")],
    )

    assert set(report_data) == {
        "schema_version",
        "analysis_profile",
        "analysis_settings",
        "analyzed_tracks",
        "skipped_files",
        "summary",
    }
    assert report_data["schema_version"] == 1
    assert report_data["analysis_profile"] == "balanced"
    assert isinstance(report_data["analyzed_tracks"], list)
    assert isinstance(report_data["skipped_files"], list)
    assert isinstance(report_data["summary"], dict)


def test_build_report_data_includes_default_analysis_settings():
    report_data = build_report_data(results=[], skipped_files=[])

    assert report_data["analysis_settings"] == {
        "energy_window_seconds": 0.25,
        "silence_threshold": 0.2,
        "sustained_window_count": 2,
        "minimum_outro_track_duration_seconds": 1.5,
        "outro_search_last_fraction": 0.35,
        "outro_search_last_seconds": 90.0,
        "intro_confidence": 0.35,
        "outro_confidence": 0.3,
        "energy_shift_min_delta": 0.45,
        "energy_shift_min_spacing_seconds": 1.0,
        "energy_shift_confidence": 0.25,
        "max_energy_shift_cues": 3,
    }


def test_build_report_data_can_include_explicit_analysis_settings():
    settings = AnalysisSettings(
        energy_window_seconds=0.1,
        silence_threshold=0.3,
        sustained_window_count=3,
        minimum_outro_track_duration_seconds=2.0,
        outro_search_last_fraction=0.2,
        outro_search_last_seconds=45.0,
        intro_confidence=0.2,
        outro_confidence=0.15,
        energy_shift_min_delta=0.55,
        energy_shift_min_spacing_seconds=1.25,
        energy_shift_confidence=0.1,
        max_energy_shift_cues=2,
    )

    report_data = build_report_data(results=[], skipped_files=[], analysis_settings=settings)

    assert report_data["analysis_settings"] == {
        "energy_window_seconds": 0.1,
        "silence_threshold": 0.3,
        "sustained_window_count": 3,
        "minimum_outro_track_duration_seconds": 2.0,
        "outro_search_last_fraction": 0.2,
        "outro_search_last_seconds": 45.0,
        "intro_confidence": 0.2,
        "outro_confidence": 0.15,
        "energy_shift_min_delta": 0.55,
        "energy_shift_min_spacing_seconds": 1.25,
        "energy_shift_confidence": 0.1,
        "max_energy_shift_cues": 2,
    }


def test_build_report_data_can_include_explicit_analysis_profile():
    report_data = build_report_data(results=[], skipped_files=[], analysis_profile=AnalysisProfile.SENSITIVE)

    assert report_data["analysis_profile"] == "sensitive"


def test_build_report_data_summary_counts():
    report_data = build_report_data(
        results=[
            _analyze_result(cues=[_cue("intro"), _cue("outro")], warnings=["heuristic warning"]),
            _analyze_result(source_file="empty.wav", sidecar_file="empty.magik-cue-genie.json"),
        ],
        skipped_files=[
            SkippedFile(source_file="notes.txt", reason="Unsupported file extension", detail=".txt"),
            SkippedFile(source_file="broken.wav", reason="Malformed WAV file", detail="bad RIFF"),
        ],
    )

    assert report_data["summary"] == {
        "analyzed_count": 2,
        "skipped_count": 2,
        "cue_count": 2,
        "warning_count": 1,
        "bpm": {
            "accepted_count": 0,
            "rejected_count": 0,
            "insufficient_onsets_count": 0,
            "missing_debug_count": 2,
            "estimated_count": 0,
        },
    }


def test_build_report_data_summary_includes_bpm_counts():
    report_data = build_report_data(
        results=[
            _analyze_result(
                source_file="accepted.wav",
                sidecar_file="accepted.magik-cue-genie.json",
                analysis=_analysis_summary(estimated_bpm=120.0, bpm_debug=_bpm_debug("accepted")),
            ),
            _analyze_result(
                source_file="rejected.wav",
                sidecar_file="rejected.magik-cue-genie.json",
                analysis=_analysis_summary(bpm_debug=_bpm_debug("rejected")),
            ),
            _analyze_result(
                source_file="insufficient.wav",
                sidecar_file="insufficient.magik-cue-genie.json",
                analysis=_analysis_summary(bpm_debug=_bpm_debug("insufficient_onsets")),
            ),
            _analyze_result(source_file="missing.wav", sidecar_file="missing.magik-cue-genie.json"),
        ],
        skipped_files=[],
    )

    assert report_data["summary"]["bpm"] == {
        "accepted_count": 1,
        "rejected_count": 1,
        "insufficient_onsets_count": 1,
        "missing_debug_count": 1,
        "estimated_count": 1,
    }


def test_cue_alignment_diagnostic_snaps_to_estimated_bpm_grid():
    diagnostic = _build_cue_alignment_diagnostic(
        {"label": "intro", "time_seconds": 1.02},
        {"estimated_bpm": 120.0, "tempo_candidates_debug": {"top_candidate_bpm": 100.0}},
    )

    assert diagnostic["source"] == "estimated_bpm"
    assert diagnostic["bpm"] == 120.0
    assert diagnostic["original_time_seconds"] == 1.02
    assert diagnostic["candidate_time_seconds"] == 1.0
    assert diagnostic["nearest_beat_number"] == 3
    assert diagnostic["nearest_bar_number"] == 1
    assert diagnostic["offset_seconds"] == -0.02
    assert diagnostic["classification"] == "near"


def test_cue_alignment_diagnostic_uses_tempo_candidate_when_estimated_bpm_missing():
    diagnostic = _build_cue_alignment_diagnostic(
        {"label": "energy_shift", "time_seconds": 1.11},
        {"estimated_bpm": None, "tempo_candidates_debug": {"top_candidate_bpm": 120.0}},
    )

    assert diagnostic["source"] == "tempo_candidates_debug"
    assert diagnostic["candidate_time_seconds"] == 1.0
    assert diagnostic["classification"] == "shifted"


def test_cue_alignment_diagnostic_reports_unavailable_without_bpm_grid():
    diagnostic = _build_cue_alignment_diagnostic(
        {"label": "intro", "time_seconds": 0.5},
        {"estimated_bpm": None, "tempo_candidates_debug": None},
    )

    assert diagnostic["classification"] == "unavailable"
    assert diagnostic["candidate_time_seconds"] is None
    assert diagnostic["nearest_beat_number"] is None
    assert diagnostic["reason"] == "No beat grid available."


def test_suggested_cue_improvement_classifies_offsets():
    unchanged = _build_suggested_cue_improvement(
        {"time_seconds": 1.0},
        {"candidate_time_seconds": 1.0},
    )
    near = _build_suggested_cue_improvement(
        {"time_seconds": 1.06},
        {"candidate_time_seconds": 1.0},
    )
    shifted = _build_suggested_cue_improvement(
        {"time_seconds": 16.75},
        {"candidate_time_seconds": 17.0},
    )
    unavailable = _build_suggested_cue_improvement(
        {"time_seconds": 2.0},
        {"candidate_time_seconds": None},
    )

    assert unchanged["classification"] == "unchanged"
    assert unchanged["reason"] == "Cue already aligns with the diagnostic beat grid; cue was not moved."
    assert near["classification"] == "near"
    assert near["offset_seconds"] == -0.06
    assert shifted["classification"] == "shifted"
    assert shifted["suggested_timestamp"] == "0:17.000"
    assert shifted["offset_seconds"] == 0.25
    assert unavailable["classification"] == "unavailable"
    assert unavailable["reason"] == "No beat-grid diagnostic was available; no suggestion made."


def test_build_report_data_analyzed_track_entry_shape():
    report_data = build_report_data(
        results=[_analyze_result(cues=[_cue("intro")], warnings=["cue detection is heuristic"])],
        skipped_files=[],
    )

    track = report_data["analyzed_tracks"][0]
    assert set(track) == {"source_file", "sidecar_file", "analysis", "cues", "warnings"}
    assert track["source_file"] == "track.wav"
    assert track["sidecar_file"] == "track.magik-cue-genie.json"
    assert track["analysis"] == {
        "duration_seconds": 2.0,
        "estimated_bpm": None,
        "estimated_bpm_confidence": None,
        "estimated_bpm_source": None,
        "bpm_debug": None,
        "beat_debug": None,
        "tempo_candidates_debug": None,
        "estimated_key": None,
        "energy_summary": {
            "window_size_seconds": 0.25,
            "max_rms": 0.5,
            "mean_rms": 0.25,
            "normalized_envelope": [0.0, 1.0],
        },
    }
    assert track["cues"] == [
        {
            "label": "intro",
            "time_seconds": 0.5,
            "confidence": 0.35,
            "reason": "test cue",
            "metadata": {
                "heuristic": "first_sustained_energy",
            },
            "alignment_diagnostic": {
                "source": None,
                "bpm": None,
                "original_time_seconds": 0.5,
                "original_timestamp": "0:00.500",
                "candidate_time_seconds": None,
                "candidate_timestamp": None,
                "nearest_beat_number": None,
                "nearest_bar_number": None,
                "offset_seconds": None,
                "classification": "unavailable",
                "reason": "No beat grid available.",
            },
            "suggested_improvement": {
                "current_time_seconds": 0.5,
                "current_timestamp": "0:00.500",
                "suggested_time_seconds": None,
                "suggested_timestamp": None,
                "offset_seconds": None,
                "classification": "unavailable",
                "reason": "No beat-grid diagnostic was available; no suggestion made.",
            },
        }
    ]
    assert track["warnings"] == ["cue detection is heuristic"]


def test_build_report_data_includes_matched_reference_metadata():
    report_data = build_report_data(
        results=[
            _analyze_result(
                source_file="Track.WAV",
                sidecar_file="Track.magik-cue-genie.json",
                analysis=_analysis_summary(estimated_bpm=121.0),
            )
        ],
        skipped_files=[],
        references={
            "track.wav": {
                "bpm": 120.0,
                "key": "8A",
                "notes": "fixture reference",
            }
        },
    )

    track = report_data["analyzed_tracks"][0]

    assert track["reference"] == {
        "bpm": 120.0,
        "key": "8A",
        "notes": "fixture reference",
    }


def test_build_report_data_is_unchanged_by_review_controls():
    report_data = build_report_data(
        results=[_analyze_result(cues=[_cue("intro")], warnings=["cue detection is heuristic"])],
        skipped_files=[SkippedFile(source_file="notes.txt", reason="Unsupported file extension", detail=".txt")],
    )

    assert set(report_data) == {
        "schema_version",
        "analysis_profile",
        "analysis_settings",
        "analyzed_tracks",
        "skipped_files",
        "summary",
    }
    assert set(report_data["analyzed_tracks"][0]) == {"source_file", "sidecar_file", "analysis", "cues", "warnings"}


def test_build_report_data_has_no_reference_key_without_reference_csv():
    report_data = build_report_data(results=[_analyze_result()], skipped_files=[])

    assert "reference" not in report_data["analyzed_tracks"][0]


def test_build_report_data_skipped_file_entry_shape():
    report_data = build_report_data(
        results=[],
        skipped_files=[SkippedFile(source_file="broken.wav", reason="Malformed WAV file", detail="bad RIFF")],
    )

    assert report_data["skipped_files"] == [
        {
            "source_file": "broken.wav",
            "reason": "Malformed WAV file",
            "detail": "bad RIFF",
        }
    ]


def test_format_timestamp_uses_minutes_seconds_milliseconds():
    assert _format_timestamp(0.0) == "0:00.000"
    assert _format_timestamp(1.25) == "0:01.250"
    assert _format_timestamp(65.125) == "1:05.125"


def test_cue_marker_position_percent_is_bounded():
    assert _cue_marker_position_percent(-1.0, 10.0) == 0.0
    assert _cue_marker_position_percent(5.0, 10.0) == 50.0
    assert _cue_marker_position_percent(15.0, 10.0) == 100.0
    assert _cue_marker_position_percent(1.0, 0.0) == 0.0


def test_empty_energy_timeline_renders_safely():
    html = _render_energy_timeline(
        {
            "duration_seconds": 1.0,
            "energy_summary": {
                "window_size_seconds": 0.25,
                "max_rms": 0.0,
                "mean_rms": 0.0,
                "normalized_envelope": [],
            },
        },
        cues=[],
    )

    assert "timeline-empty" in html
    assert "empty envelope" in html


def test_energy_timeline_uses_marker_lines_and_compact_legend():
    html = _render_energy_timeline(
        {
            "duration_seconds": 2.0,
            "estimated_bpm": None,
            "energy_summary": {
                "window_size_seconds": 0.25,
                "max_rms": 0.5,
                "mean_rms": 0.25,
                "normalized_envelope": [0.0, 1.0, 0.5, 0.25],
            },
        },
        cues=[
            {
                "label": "intro",
                "time_seconds": 0.1,
                "confidence": 0.35,
                "reason": "test",
                "metadata": {"heuristic": "first_sustained_energy"},
            },
            {
                "label": "energy_shift",
                "time_seconds": 0.2,
                "confidence": 0.25,
                "reason": "test",
            },
        ],
    )

    assert "timeline-bar" in html
    assert "timeline-marker" in html
    assert 'class="timeline-marker cue-marker-intro"' in html
    assert 'class="timeline-marker cue-marker-energy-shift"' in html
    assert '<rect class="timeline-marker' not in html
    assert 'stroke-width="2"' not in html
    assert 'class="timeline-marker-cap cue-marker-intro"' in html
    assert "timeline-legend" in html
    assert "Label: intro" in html
    assert "Timestamp: 0:00.100" in html
    assert "Confidence: 0.35" in html
    assert "Reason: test" in html
    assert "Metadata: heuristic: first_sustained_energy" in html
    assert "Label: energy_shift" in html
    assert "Timestamp: 0:00.200" in html
    assert "intro 0:00.100" in html
    assert "energy_shift 0:00.200" in html
    assert "timeline-marker-label" not in html
    assert "timeline-bpm-tick" not in html
    assert "BPM grid" not in html


def test_energy_timeline_renders_bpm_ticks_only_when_bpm_is_present():
    analysis = {
        "duration_seconds": 8.0,
        "estimated_bpm": 120.0,
        "energy_summary": {
            "window_size_seconds": 0.25,
            "max_rms": 0.5,
            "mean_rms": 0.25,
            "normalized_envelope": [0.0, 1.0, 0.5, 0.25],
        },
    }

    html = _render_energy_timeline(analysis, cues=[])
    html_without_bpm = _render_energy_timeline({**analysis, "estimated_bpm": None}, cues=[])

    assert "timeline-bpm-tick" in html
    assert "BPM grid: 120.0, 4-beat ticks" in html
    assert "timeline-bpm-tick" not in html_without_bpm
    assert "BPM grid" not in html_without_bpm


def test_energy_timeline_caps_bpm_tick_density():
    html = _render_energy_timeline(
        {
            "duration_seconds": 600.0,
            "estimated_bpm": 180.0,
            "energy_summary": {
                "window_size_seconds": 0.25,
                "max_rms": 0.5,
                "mean_rms": 0.25,
                "normalized_envelope": [0.2, 0.8, 0.4, 0.6],
            },
        },
        cues=[],
    )

    assert 1 <= html.count("timeline-bpm-tick") <= 80


def test_energy_timeline_uses_fallback_marker_classes_for_future_labels():
    html = _render_energy_timeline(
        {
            "duration_seconds": 4.0,
            "estimated_bpm": None,
            "energy_summary": {
                "window_size_seconds": 0.25,
                "max_rms": 0.5,
                "mean_rms": 0.25,
                "normalized_envelope": [0.0, 1.0],
            },
        },
        cues=[
            {
                "label": "future_label",
                "time_seconds": 1.0,
                "confidence": 0.2,
                "reason": "future cue",
            }
        ],
    )

    assert "timeline-marker cue-marker-fallback-" in html
    assert "future_label 0:01.000" in html


def test_render_report_shows_cue_alignment_diagnostics_when_bpm_candidate_exists():
    report_data = build_report_data(
        results=[
            _analyze_result(
                cues=[_cue("intro")],
                analysis=_analysis_summary(estimated_bpm=120.0),
            )
        ],
        skipped_files=[],
    )

    html = render_report(report_data)
    alignment = report_data["analyzed_tracks"][0]["cues"][0]["alignment_diagnostic"]

    assert alignment["source"] == "estimated_bpm"
    assert alignment["candidate_timestamp"] == "0:00.500"
    assert alignment["classification"] == "unchanged"
    assert "Cue Alignment Diagnostics" in html
    assert "Report-only beat-snap suggestions" in html
    assert "<th>Alignment</th>" in html
    assert "0:00.500 (unchanged, +0.000s)" in html
    assert "Suggested Cue Improvements" in html
    assert "These are report-only suggestions. Sidecar cue timestamps were not changed." in html
    assert "Cue already aligns with the diagnostic beat grid; cue was not moved." in html


def test_render_report_cue_alignment_diagnostics_render_safely_without_bpm():
    report_data = build_report_data(results=[_analyze_result(cues=[_cue("intro")])], skipped_files=[])

    html = render_report(report_data)
    alignment = report_data["analyzed_tracks"][0]["cues"][0]["alignment_diagnostic"]

    assert alignment["classification"] == "unavailable"
    assert alignment["reason"] == "No beat grid available."
    assert "Cue Alignment Diagnostics" in html
    assert "No beat grid available." in html
    assert "Suggested Cue Improvements" in html
    assert "No beat-grid diagnostic was available; no suggestion made." in html


def test_render_report_shows_unchanged_near_and_shifted_cue_improvements():
    cues = [
        CueSuggestion(label="intro", time_seconds=0.5, confidence=0.3, reason="test"),
        CueSuggestion(label="energy_shift", time_seconds=0.56, confidence=0.3, reason="test"),
        CueSuggestion(label="outro", time_seconds=0.75, confidence=0.3, reason="test"),
    ]
    report_data = build_report_data(
        results=[
            _analyze_result(
                cues=cues,
                analysis=_analysis_summary(estimated_bpm=120.0),
            )
        ],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert "Suggested Cue Improvements" in html
    assert "<th>Current time</th><th>Suggested time</th><th>Offset</th><th>Class</th><th>Reason</th>" in html
    assert "0:00.500</td><td>0:00.500</td><td>+0.000s</td><td>unchanged" in html
    assert "0:00.560</td><td>0:00.500</td><td>-0.060s</td><td>near" in html
    assert "0:00.750</td><td>0:01.000</td><td>+0.250s</td><td>shifted" in html
    assert "Report-only suggestion from nearest beat-grid alignment; cue was not moved." in html


def test_render_report_shows_summary_timestamps_metadata_and_skipped_files():
    report_data = build_report_data(
        results=[_analyze_result(cues=[_cue("intro")], warnings=["review this cue"])],
        skipped_files=[SkippedFile(source_file="notes.txt", reason="Unsupported file extension", detail=".txt")],
    )

    html = render_report(report_data)

    assert "Run Summary" in html
    assert "Analysis profile" in html
    assert "balanced" in html
    assert "0:00.500" in html
    assert "heuristic: first_sustained_energy" in html
    assert "Track Warnings" in html
    assert "Diagnostics" in html
    assert "Cue count</dt><dd>1" in html
    assert "Warning count</dt><dd>1" in html
    assert "BPM estimate</dt><dd>Unknown" in html
    assert "BPM debug status</dt><dd>Unknown" in html
    assert "No BPM debug data available." in html
    assert "Cue labels</dt><dd>intro" in html
    assert "Estimated BPMs" in html
    assert "BPM debug" in html
    assert "accepted 0, rejected 0, insufficient 0, missing 1" in html
    assert "review this cue" in html
    assert "Skipped files" in html
    assert "notes.txt" in html
    assert "Normalized RMS energy timeline" in html
    assert "timeline-bar" in html
    assert "timeline-marker" in html
    assert "timeline-legend" in html
    assert "Label: intro" in html
    assert "Timestamp: 0:00.500" in html
    assert "intro 0:00.500" in html
    assert "timeline-marker-label" not in html


def test_render_report_without_beat_debug_omits_beat_visuals():
    report_data = build_report_data(results=[_analyze_result()], skipped_files=[])

    html = render_report(report_data)

    assert "Beat Grid / Onset Visuals" not in html
    assert 'class="beat-visual-onset"' not in html
    assert "Tempo Candidate Diagnostics" not in html


def test_render_report_includes_review_controls_for_cue_rows():
    report_data = build_report_data(
        results=[_analyze_result(cues=[_cue("intro")])],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert "<th>Review</th>" in html
    assert 'class="track-section"' in html
    assert 'class="review-row"' in html
    assert 'class="review-rating"' in html
    assert '<option value="good">good</option>' in html
    assert '<option value="early">early</option>' in html
    assert '<option value="late">late</option>' in html
    assert '<option value="wrong">wrong</option>' in html
    assert '<option value="maybe">maybe</option>' in html
    assert 'class="review-note"' in html
    assert 'data-source-file="track.wav"' in html
    assert 'data-cue-label="intro"' in html
    assert 'data-cue-timestamp="0:00.500"' in html


def test_render_report_includes_review_reference_controls_per_track():
    report_data = build_report_data(
        results=[_analyze_result(analysis=_analysis_summary(estimated_bpm=121.25))],
        skipped_files=[],
        references={
            "track.wav": {
                "bpm": 120.0,
                "key": "8A",
                "notes": "manual QA reference",
            }
        },
    )

    html = render_report(report_data)

    assert "Review / Reference" in html
    assert 'class="track-reference-bpm"' in html
    assert 'value="120.0"' in html
    assert 'class="track-reference-key"' in html
    assert 'value="8A"' in html
    assert 'class="track-reference-source"' in html
    assert 'class="track-reviewer-notes"' in html
    assert ">manual QA reference</textarea>" in html


def test_render_report_escapes_review_data_attributes():
    report_data = build_report_data(
        results=[_analyze_result(source_file='Track "One".wav', sidecar_file='Track "One".magik-cue-genie.json')],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert 'data-source-file="Track &quot;One&quot;.wav"' in html
    assert 'data-sidecar-file="Track &quot;One&quot;.magik-cue-genie.json"' in html


def test_render_report_includes_track_diagnostics_with_bpm_debug():
    report_data = build_report_data(
        results=[
            _analyze_result(
                cues=[_cue("intro"), _cue("outro")],
                warnings=["review this track"],
                analysis=_analysis_summary(estimated_bpm=120.0, bpm_debug=_bpm_debug("accepted")),
            )
        ],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert "Diagnostics" in html
    assert "Cue count</dt><dd>2" in html
    assert "Warning count</dt><dd>1" in html
    assert "BPM estimate</dt><dd>120.0 (confidence 0.88, rms_onset_interval)" in html
    assert "BPM debug status</dt><dd>accepted" in html
    assert "BPM debug reason</dt><dd>test bpm debug" in html
    assert "Cue labels</dt><dd>intro, outro" in html
    assert "<th>Review</th>" in html
    assert "BPM Debug" in html


def test_render_report_includes_no_cue_review_area():
    report_data = build_report_data(
        results=[_analyze_result(source_file="empty.wav", sidecar_file="empty.magik-cue-genie.json")],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert "No cue suggestions yet." in html
    assert "No-Cue Review" in html
    assert 'class="no-cue-review review-row"' in html
    assert 'data-source-file="empty.wav"' in html
    assert 'data-cue-label=""' in html
    assert 'class="review-rating"' in html
    assert 'class="review-note"' in html


def test_render_report_includes_review_feedback_download_script():
    report_data = build_report_data(results=[_analyze_result(cues=[_cue("intro")])], skipped_files=[])

    html = render_report(report_data)

    assert "Download review feedback" in html
    assert 'id="download-review-feedback"' in html
    assert "magik-cue-genie-review-feedback.json" in html
    assert "collectFeedback" in html
    assert "collectCueFeedback" in html
    assert "source_file" in html
    assert "reference_bpm" in html
    assert "reference_key" in html
    assert "reference_source" in html
    assert "reviewer_notes" in html
    assert "review_rating" in html
    assert "review_note" in html
    assert "generated_at" in html


def test_render_report_includes_expand_and_collapse_all_details_controls():
    report_data = build_report_data(
        results=[
            _analyze_result(
                cues=[_cue("intro")],
                analysis=_analysis_summary(estimated_bpm=120.0, bpm_debug=_bpm_debug("accepted")),
            )
        ],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert 'id="expand-all-details"' in html
    assert ">Expand all</button>" in html
    assert 'id="collapse-all-details"' in html
    assert ">Collapse all</button>" in html
    assert 'document.querySelectorAll("details")' in html
    assert "details.open = isOpen" in html
    assert "setAllDetailsOpen(true)" in html
    assert "setAllDetailsOpen(false)" in html
    assert '<details class="diagnostics">' in html
    assert '<details class="bpm-debug">' in html


def test_render_report_shows_previous_feedback_overlay_for_matched_track_and_cue():
    report_data = build_report_data(
        results=[_analyze_result(cues=[_cue("intro")])],
        skipped_files=[],
    )
    previous_feedback = {
        "track.wav": {
            "source_file": "Track.WAV",
            "cue_feedback": [
                {
                    "cue_label": "intro",
                    "cue_time_seconds": "0.505",
                    "review_rating": "early",
                    "review_note": "starts too soon",
                },
                {
                    "cue_label": "outro",
                    "cue_time_seconds": "20.0",
                    "review_rating": "good",
                    "review_note": "",
                },
                {
                    "cue_label": "energy_shift",
                    "cue_time_seconds": "10.0",
                    "review_rating": "",
                    "review_note": "",
                },
            ],
        }
    }

    html = render_report(report_data, previous_feedback=previous_feedback)

    assert "Previous review" in html
    assert "Rating counts: good 1, early 1, late 0, wrong 0, maybe 0, blank 1" in html
    assert "<th>Previous Review</th>" in html
    assert "early - starts too soon" in html


def test_render_report_shows_previous_feedback_no_match_note_only_when_loaded():
    report_data = build_report_data(results=[_analyze_result(cues=[_cue("intro")])], skipped_files=[])

    html_without_feedback = render_report(report_data)
    html_with_unmatched_feedback = render_report(report_data, previous_feedback={"other.wav": {"cue_feedback": []}})

    assert "Previous review" not in html_without_feedback
    assert "No previous feedback loaded for this track." in html_with_unmatched_feedback
    assert "<th>Previous Review</th>" not in html_with_unmatched_feedback


def test_render_report_without_feedback_has_no_reference_comparison():
    report_data = build_report_data(results=[_analyze_result()], skipped_files=[])

    html = render_report(report_data)

    assert "Reference BPM Comparison" not in html
    assert "Reference comparison" not in html


def test_render_report_shows_reference_bpm_comparison_from_previous_feedback():
    report_data = build_report_data(
        results=[
            _analyze_result(
                analysis=_analysis_summary(estimated_bpm=121.25, estimated_key="8A"),
            )
        ],
        skipped_files=[],
    )
    previous_feedback = {
        "track.wav": {
            "source_file": "track.wav",
            "reference_bpm": "120.0",
            "reference_key": "8A",
            "reference_source": "https://example.test/track",
            "cue_feedback": [],
        }
    }

    html = render_report(report_data, previous_feedback=previous_feedback)

    assert "Reference BPM Comparison" in html
    assert "Tracks with reference BPM</dt><dd>1" in html
    assert "Tracks with estimated BPM</dt><dd>1" in html
    assert "Exact/near BPM matches</dt><dd>0" in html
    assert "BPM misses/unknowns</dt><dd>1" in html
    assert "Reference comparison" in html
    assert "Estimated BPM</dt><dd>121.25" in html
    assert "Reference BPM</dt><dd>120.0" in html
    assert "BPM difference</dt><dd>1.25" in html
    assert "Half/double-time diagnostic</dt><dd>miss" in html
    assert "Estimated Key</dt><dd>8A" in html
    assert "Reference Key</dt><dd>8A" in html
    assert "Reference source</dt><dd>https://example.test/track" in html


def test_render_report_reference_bpm_with_unknown_estimate_is_unknown():
    report_data = build_report_data(results=[_analyze_result()], skipped_files=[])
    previous_feedback = {
        "track.wav": {
            "source_file": "track.wav",
            "reference_bpm": "120.0",
            "reference_key": "8A",
            "reference_source": "",
            "cue_feedback": [],
        }
    }

    html = render_report(report_data, previous_feedback=previous_feedback)

    assert "Tracks with reference BPM</dt><dd>1" in html
    assert "Tracks with estimated BPM</dt><dd>0" in html
    assert "BPM misses/unknowns</dt><dd>1" in html
    assert "Estimated BPM</dt><dd>Unknown" in html
    assert "Reference BPM</dt><dd>120.0" in html
    assert "BPM difference</dt><dd>Unknown" in html
    assert "Half/double-time diagnostic</dt><dd>unknown" in html


def test_render_report_reference_bpm_detects_half_double_time_diagnostic():
    report_data = build_report_data(
        results=[
            _analyze_result(
                analysis=_analysis_summary(estimated_bpm=60.0),
            )
        ],
        skipped_files=[],
    )
    previous_feedback = {
        "track.wav": {
            "source_file": "track.wav",
            "reference_bpm": "120.0",
            "reference_key": "",
            "reference_source": "",
            "cue_feedback": [],
        }
    }

    html = render_report(report_data, previous_feedback=previous_feedback)

    assert "Possible half/double-time matches</dt><dd>1" in html
    assert "BPM misses/unknowns</dt><dd>0" in html
    assert "BPM difference</dt><dd>60.00" in html
    assert "Half/double-time diagnostic</dt><dd>possible half-time match" in html


def test_render_report_shows_bpm_confidence_and_source_when_present():
    bpm_debug = {
        "source": "rms_onset_interval",
        "status": "accepted",
        "onset_times_seconds": [0.5, 1.0, 1.5, 2.0],
        "intervals_seconds": [0.5, 0.5, 0.5],
        "candidate_bpms": [120.0, 120.0, 120.0],
        "selected_bpm": 120.0,
        "confidence": 0.875,
        "reason": "Stable RMS onset intervals produced a BPM estimate.",
    }
    beat_debug = {
        "source": "rms_onset_interval",
        "status": "accepted",
        "onset_times_seconds": [0.5, 1.0, 1.5, 2.0],
        "local_peak_times_seconds": [0.5, 1.0, 1.5, 2.0],
        "candidate_beat_intervals_seconds": [0.5, 0.5, 0.5],
        "normalized_candidate_bpms": [120.0, 120.0, 120.0],
        "selected_beat_interval_seconds": 0.5,
        "selected_bpm": 120.0,
        "confidence": 0.875,
        "reason": "Stable RMS onset intervals produced beat timing diagnostics.",
    }
    tempo_candidates_debug = {
        "source": "local_energy_peaks",
        "status": "accepted",
        "local_peak_count": 8,
        "candidate_bpms": [
            {
                "bpm": 120.0,
                "count": 7,
                "score": 0.95,
                "local_peak_count_score": 0.875,
                "onset_candidate_support_score": 1.0,
                "interval_stability_score": 1.0,
                "source": "local_energy_peaks",
                "notes": "mean interval 0.500s from repeated local energy peaks; also supported by RMS onset BPM candidates",
            }
        ],
        "top_candidate_bpm": 120.0,
        "top_candidate_confidence": 0.95,
        "estimated_bpm_agreement": "agrees",
        "reason": "Repeated local energy peak intervals produced tempo candidates.",
    }
    sidecar = TrackSidecar(
        source_file="pulse.wav",
        analysis=AnalysisSummary(
            duration_seconds=8.0,
            estimated_bpm=120.0,
            estimated_bpm_confidence=0.875,
            estimated_bpm_source="rms_onset_interval",
            bpm_debug=bpm_debug,
            beat_debug=beat_debug,
            tempo_candidates_debug=tempo_candidates_debug,
            energy_summary=EnergySummary(
                window_size_seconds=0.25,
                max_rms=0.5,
                mean_rms=0.25,
                normalized_envelope=[0.0, 1.0],
            ),
        ),
    )
    report_data = build_report_data(
        results=[AnalyzeResult(audio_path=Path("pulse.wav"), sidecar_path=Path("pulse.magik-cue-genie.json"), sidecar=sidecar)],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert report_data["analyzed_tracks"][0]["analysis"]["bpm_debug"] == bpm_debug
    assert report_data["analyzed_tracks"][0]["analysis"]["beat_debug"] == beat_debug
    assert report_data["analyzed_tracks"][0]["analysis"]["tempo_candidates_debug"] == tempo_candidates_debug
    assert "120.0 (confidence 0.88, rms_onset_interval)" in html
    assert "BPM Debug" in html
    assert "Beat / Onset Diagnostics" in html
    assert "Beat Grid / Onset Visuals" in html
    assert "accepted" in html
    assert "Stable RMS onset intervals produced a BPM estimate." in html
    assert "Stable RMS onset intervals produced beat timing diagnostics." in html
    assert "Candidate beat intervals" in html
    assert "Detected onsets</dt><dd>4" in html
    assert "Local energy peaks</dt><dd>4" in html
    assert "Selected beat interval</dt><dd>0.5" in html
    assert "beat-visual-onset" in html
    assert "beat-visual-peak" in html
    assert "beat-visual-grid" in html
    assert "blue: onsets" in html
    assert "Tempo Candidate Diagnostics" in html
    assert "Top candidate BPM</dt><dd>120.0" in html
    assert "Top candidate confidence</dt><dd>0.95" in html
    assert "Accepted BPM agreement</dt><dd>agrees" in html
    assert "<th>Score</th>" in html
    assert "<th>Onset support</th>" in html
    assert "<th>Stability</th>" in html
    assert "mean interval 0.500s from repeated local energy peaks" in html
    assert "also supported by RMS onset BPM candidates" in html
    assert "0.5, 0.5, 0.5" in html
    assert "120.0, 120.0, 120.0" in html


def test_render_report_shows_tempo_candidate_reference_comparison_from_previous_feedback():
    tempo_candidates_debug = {
        "source": "local_energy_peaks",
        "status": "accepted",
        "local_peak_count": 10,
        "candidate_bpms": [
            {
                "bpm": 137.1,
                "count": 6,
                "score": 0.82,
                "local_peak_count_score": 0.75,
                "onset_candidate_support_score": 0.67,
                "interval_stability_score": 0.96,
                "source": "local_energy_peaks+rms_onset_candidates",
                "notes": "stable local peak interval; also supported by RMS onset BPM candidates",
            },
            {
                "bpm": 120.0,
                "count": 8,
                "score": 0.54,
                "local_peak_count_score": 1.0,
                "onset_candidate_support_score": 0.0,
                "interval_stability_score": 0.9,
                "source": "local_energy_peaks",
                "notes": "generic 120 BPM dense-peak penalty applied",
            },
        ],
        "top_candidate_bpm": 137.1,
        "top_candidate_confidence": 0.82,
        "estimated_bpm_agreement": "estimated_bpm_unknown",
        "reason": "Repeated local energy peak intervals produced tempo candidates.",
    }
    report_data = build_report_data(
        results=[
            _analyze_result(
                analysis=_analysis_summary(estimated_bpm=None, tempo_candidates_debug=tempo_candidates_debug),
            )
        ],
        skipped_files=[],
    )
    previous_feedback = {
        "track.wav": {
            "source_file": "track.wav",
            "reference_bpm": "136.0",
            "reference_key": "",
            "reference_source": "",
            "cue_feedback": [],
        }
    }

    html = render_report(report_data, previous_feedback=previous_feedback)

    assert "Tempo candidate/reference comparison" in html
    assert "Closest candidate to reference</dt><dd>137.1" in html
    assert "Candidate/reference BPM difference</dt><dd>1.10" in html
    assert "local_energy_peaks+rms_onset_candidates" in html
    assert "Top candidate reference result</dt><dd>near-matches reference" in html


def test_render_report_reference_bpm_does_not_affect_tempo_candidate_ranking_without_feedback():
    tempo_candidates_debug = {
        "source": "local_energy_peaks",
        "status": "accepted",
        "local_peak_count": 10,
        "candidate_bpms": [
            {
                "bpm": 120.0,
                "count": 8,
                "score": 0.7,
                "local_peak_count_score": 1.0,
                "onset_candidate_support_score": 0.0,
                "interval_stability_score": 0.9,
                "source": "local_energy_peaks",
                "notes": "local-only candidate",
            },
            {
                "bpm": 137.1,
                "count": 3,
                "score": 0.65,
                "local_peak_count_score": 0.0,
                "onset_candidate_support_score": 0.33,
                "interval_stability_score": 0.0,
                "source": "rms_onset_candidates",
                "notes": "candidate from RMS onset interval list",
            },
        ],
        "top_candidate_bpm": 120.0,
        "top_candidate_confidence": 0.7,
        "estimated_bpm_agreement": "estimated_bpm_unknown",
        "reason": "Repeated local energy peak intervals produced tempo candidates.",
    }
    report_data = build_report_data(
        results=[
            _analyze_result(
                analysis=_analysis_summary(tempo_candidates_debug=tempo_candidates_debug),
            )
        ],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert "Top candidate BPM</dt><dd>120.0" in html
    assert "Tempo candidate/reference comparison" not in html
    assert report_data["analyzed_tracks"][0]["analysis"]["tempo_candidates_debug"]["top_candidate_bpm"] == 120.0


def test_render_report_shows_reference_values_and_bpm_delta():
    report_data = build_report_data(
        results=[
            _analyze_result(
                analysis=_analysis_summary(estimated_bpm=121.25),
            )
        ],
        skipped_files=[],
        references={
            "track.wav": {
                "bpm": 120.0,
                "key": "8A",
                "notes": "manual QA reference",
            }
        },
    )

    html = render_report(report_data)

    assert "Reference" in html
    assert "Reference BPM</dt><dd>120.0" in html
    assert "Reference Key</dt><dd>8A" in html
    assert "manual QA reference" in html
    assert "BPM delta</dt><dd>+1.25" in html


def test_render_report_shows_aggregate_bpm_summary_counts():
    report_data = build_report_data(
        results=[
            _analyze_result(
                source_file="accepted.wav",
                sidecar_file="accepted.magik-cue-genie.json",
                analysis=_analysis_summary(estimated_bpm=120.0, bpm_debug=_bpm_debug("accepted")),
            ),
            _analyze_result(
                source_file="rejected.wav",
                sidecar_file="rejected.magik-cue-genie.json",
                analysis=_analysis_summary(bpm_debug=_bpm_debug("rejected")),
            ),
            _analyze_result(
                source_file="insufficient.wav",
                sidecar_file="insufficient.magik-cue-genie.json",
                analysis=_analysis_summary(bpm_debug=_bpm_debug("insufficient_onsets")),
            ),
            _analyze_result(source_file="missing.wav", sidecar_file="missing.magik-cue-genie.json"),
        ],
        skipped_files=[],
    )

    html = render_report(report_data)

    assert "Estimated BPMs</dt><dd>1" in html
    assert "accepted 1, rejected 1, insufficient 1, missing 1" in html


def _analyze_result(
    source_file="track.wav",
    sidecar_file="track.magik-cue-genie.json",
    cues=None,
    warnings=None,
    analysis=None,
):
    sidecar = TrackSidecar(
        source_file=source_file,
        analysis=analysis or _analysis_summary(),
        cues=cues or [],
        warnings=warnings or [],
    )
    return AnalyzeResult(
        audio_path=Path(source_file),
        sidecar_path=Path(sidecar_file),
        sidecar=sidecar,
    )


def _analysis_summary(estimated_bpm=None, bpm_debug=None, estimated_key=None, tempo_candidates_debug=None):
    return AnalysisSummary(
        duration_seconds=2.0,
        estimated_bpm=estimated_bpm,
        estimated_bpm_confidence=0.875 if estimated_bpm is not None else None,
        estimated_bpm_source="rms_onset_interval" if estimated_bpm is not None else None,
        bpm_debug=bpm_debug,
        beat_debug=None,
        tempo_candidates_debug=tempo_candidates_debug,
        estimated_key=estimated_key,
        energy_summary=EnergySummary(
            window_size_seconds=0.25,
            max_rms=0.5,
            mean_rms=0.25,
            normalized_envelope=[0.0, 1.0],
        ),
    )


def _bpm_debug(status):
    return {
        "source": "rms_onset_interval",
        "status": status,
        "onset_times_seconds": [0.5, 1.0, 1.5, 2.0] if status == "accepted" else [],
        "intervals_seconds": [0.5, 0.5, 0.5] if status == "accepted" else [],
        "candidate_bpms": [120.0, 120.0, 120.0] if status == "accepted" else [],
        "selected_bpm": 120.0 if status == "accepted" else None,
        "confidence": 0.875 if status == "accepted" else None,
        "reason": "test bpm debug",
    }


def _cue(label):
    return CueSuggestion(
        label=label,
        time_seconds=0.5,
        confidence=0.35,
        reason="test cue",
        metadata={"heuristic": "first_sustained_energy"},
    )
