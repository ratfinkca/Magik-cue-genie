import subprocess
from pathlib import Path

import pytest

import magik_cue_genie.analysis as analysis_module
from magik_cue_genie.analysis import AnalysisProfile, AnalysisSettings, analyze_audio, get_analysis_settings_profile

from conftest import write_pulse_wav, write_segmented_wav, write_silence_then_tone_wav, write_silent_wav, write_tone_wav


def test_silence_only_wav_produces_no_cues(tmp_path):
    audio_path = tmp_path / "silence.wav"
    write_silent_wav(audio_path, duration_seconds=2.0)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.cues == []


def test_initial_silence_then_tone_produces_intro_near_tone_start(tmp_path):
    audio_path = tmp_path / "delayed-tone.wav"
    write_silence_then_tone_wav(audio_path, silence_seconds=0.5, tone_seconds=0.5)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    cues = result.sidecar.cues
    assert len(cues) == 1
    assert cues[0].label == "intro"
    assert 0.45 <= cues[0].time_seconds <= 0.55
    assert cues[0].confidence == 0.35
    assert cues[0].metadata == {"heuristic": "first_sustained_energy"}


def test_steady_tone_from_beginning_produces_intro_near_zero(tmp_path):
    audio_path = tmp_path / "steady-tone.wav"
    write_tone_wav(audio_path, amplitude=0.4, duration_seconds=0.5)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    cues = result.sidecar.cues
    assert len(cues) == 1
    assert cues[0].label == "intro"
    assert cues[0].time_seconds == 0.0
    assert "energy_shift" not in [cue.label for cue in cues]


def test_tone_with_trailing_silence_produces_outro_before_silence_or_end(tmp_path):
    audio_path = tmp_path / "tone-then-silence.wav"
    write_segmented_wav(audio_path, [("tone", 1.5, 0.5), ("silence", 0.5, 0.0)])

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    outros = [cue for cue in result.sidecar.cues if cue.label == "outro"]
    assert len(outros) == 1
    assert 0.5 <= outros[0].time_seconds < 1.5
    assert outros[0].confidence == 0.3
    assert "not beat- or phrase-aware" in outros[0].reason
    assert outros[0].metadata == {"heuristic": "final_sustained_energy"}


def test_longer_intro_tone_outro_shape_produces_intro_and_outro(tmp_path):
    audio_path = tmp_path / "structured.wav"
    write_segmented_wav(
        audio_path,
        [
            ("silence", 0.5, 0.0),
            ("tone", 1.0, 0.5),
            ("silence", 0.5, 0.0),
            ("tone", 1.0, 0.4),
            ("silence", 0.5, 0.0),
        ],
    )

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    cues_by_label = {cue.label: cue for cue in result.sidecar.cues}
    assert set(cues_by_label) == {"intro", "outro"}
    assert 0.45 <= cues_by_label["intro"].time_seconds <= 0.55
    assert 2.0 <= cues_by_label["outro"].time_seconds < 3.0


def test_very_short_wav_does_not_produce_misleading_outro(tmp_path):
    audio_path = tmp_path / "short.wav"
    write_tone_wav(audio_path, amplitude=0.4, duration_seconds=0.5)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert [cue.label for cue in result.sidecar.cues] == ["intro"]


def test_long_track_with_early_energy_does_not_place_outro_near_beginning(tmp_path):
    audio_path = tmp_path / "early-energy.wav"
    write_segmented_wav(
        audio_path,
        [
            ("tone", 10.0, 0.5),
            ("silence", 170.0, 0.0),
        ],
        frame_rate=8_000,
    )

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert "outro" not in [cue.label for cue in result.sidecar.cues]


def test_long_track_with_trailing_silence_places_outro_in_final_region(tmp_path):
    audio_path = tmp_path / "late-outro.wav"
    write_segmented_wav(
        audio_path,
        [
            ("silence", 10.0, 0.0),
            ("tone", 150.0, 0.5),
            ("silence", 10.0, 0.0),
        ],
        frame_rate=8_000,
    )

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    outros = [cue for cue in result.sidecar.cues if cue.label == "outro"]
    assert len(outros) == 1
    assert outros[0].time_seconds >= 110.5
    assert outros[0].time_seconds < 170.0


def test_long_track_cue_times_use_analysis_windows_not_display_buckets(tmp_path):
    audio_path = tmp_path / "long-energy-changes.wav"
    write_segmented_wav(
        audio_path,
        [("silence", 20.0, 0.0), ("tone", 30.0, 0.2), ("tone", 50.0, 0.8)],
        frame_rate=8_000,
    )

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    intro = next(cue for cue in result.sidecar.cues if cue.label == "intro")
    shift = next(cue for cue in result.sidecar.cues if cue.label == "energy_shift")
    assert 19.75 <= intro.time_seconds <= 20.25
    assert 49.75 <= shift.time_seconds <= 50.25
    summary = result.sidecar.analysis.energy_summary
    assert summary is not None
    assert len(summary.normalized_envelope) <= 200
    assert summary.window_size_seconds == 0.25


def test_short_demo_like_file_still_produces_reasonable_outro(tmp_path):
    audio_path = tmp_path / "demo-outro.wav"
    write_segmented_wav(
        audio_path,
        [
            ("tone", 2.0, 0.45),
            ("silence", 0.75, 0.0),
        ],
    )

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    outros = [cue for cue in result.sidecar.cues if cue.label == "outro"]
    assert len(outros) == 1
    assert 1.75 <= outros[0].time_seconds < 2.75


def test_clear_120_bpm_pulse_pattern_estimates_bpm_without_changing_cues(tmp_path):
    audio_path = tmp_path / "pulse-120.wav"
    write_pulse_wav(audio_path, bpm=120, beat_count=16)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.estimated_bpm == pytest.approx(120.0, abs=1.0)
    assert result.sidecar.analysis.estimated_bpm_confidence is not None
    assert result.sidecar.analysis.estimated_bpm_confidence >= 0.6
    assert result.sidecar.analysis.estimated_bpm_source == "rms_onset_interval"
    assert result.sidecar.analysis.bpm_debug is not None
    assert result.sidecar.analysis.bpm_debug["status"] == "accepted"
    assert result.sidecar.analysis.bpm_debug["source"] == "rms_onset_interval"
    assert result.sidecar.analysis.bpm_debug["selected_bpm"] == pytest.approx(120.0, abs=1.0)
    assert result.sidecar.analysis.bpm_debug["confidence"] == result.sidecar.analysis.estimated_bpm_confidence
    assert len(result.sidecar.analysis.bpm_debug["onset_times_seconds"]) >= 4
    assert len(result.sidecar.analysis.bpm_debug["candidate_bpms"]) >= 3
    assert result.sidecar.analysis.beat_debug is not None
    assert result.sidecar.analysis.beat_debug["status"] == "accepted"
    assert result.sidecar.analysis.beat_debug["source"] == "rms_onset_interval"
    assert result.sidecar.analysis.beat_debug["selected_bpm"] == pytest.approx(120.0, abs=1.0)
    assert result.sidecar.analysis.beat_debug["selected_beat_interval_seconds"] == pytest.approx(0.5, abs=0.1)
    assert len(result.sidecar.analysis.beat_debug["candidate_beat_intervals_seconds"]) >= 3
    assert len(result.sidecar.analysis.beat_debug["normalized_candidate_bpms"]) >= 3
    assert result.sidecar.analysis.tempo_candidates_debug is not None
    assert result.sidecar.analysis.tempo_candidates_debug["source"] == "local_energy_peaks"
    assert result.sidecar.analysis.tempo_candidates_debug["top_candidate_bpm"] == pytest.approx(120.0, abs=2.0)
    assert result.sidecar.analysis.tempo_candidates_debug["top_candidate_confidence"] is not None
    assert result.sidecar.analysis.tempo_candidates_debug["candidate_bpms"]
    top_candidate = result.sidecar.analysis.tempo_candidates_debug["candidate_bpms"][0]
    assert set(top_candidate) >= {
        "local_peak_count_score",
        "onset_candidate_support_score",
        "interval_stability_score",
        "notes",
    }
    assert top_candidate["onset_candidate_support_score"] > 0
    assert result.sidecar.analysis.tempo_candidates_debug["estimated_bpm_agreement"] == "agrees"
    assert {cue.label for cue in result.sidecar.cues}.issubset({"intro", "outro", "energy_shift"})


def test_tempo_candidate_scoring_prefers_onset_supported_candidate_over_dense_120():
    peak_times = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 3.561, 4.122, 4.683, 5.244]

    candidates = analysis_module._score_tempo_candidates_from_peaks(peak_times, onset_candidate_bpms=[107.0])

    assert candidates[0]["bpm"] == pytest.approx(107.0, abs=1.0)
    assert candidates[0]["onset_candidate_support_score"] > 0
    assert "also supported by RMS onset BPM candidates" in candidates[0]["notes"]
    dense_120 = next(candidate for candidate in candidates if candidate["bpm"] == pytest.approx(120.0, abs=1.0))
    assert dense_120["score"] < candidates[0]["score"]
    assert "generic 120 BPM dense-peak penalty applied" in dense_120["notes"]


def test_mad_world_style_onset_cluster_ranks_106_7_above_generic_120():
    peak_times = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 3.75, 4.5, 5.25]

    candidates = analysis_module._score_tempo_candidates_from_peaks(
        peak_times,
        onset_candidate_bpms=[120.0, 106.7, 106.7, 106.7],
    )

    assert candidates[0]["bpm"] == pytest.approx(106.7, abs=0.1)
    generic_120 = next(candidate for candidate in candidates if candidate["bpm"] == pytest.approx(120.0, abs=0.1))
    assert candidates[0]["onset_candidate_support_score"] == 1.0
    assert candidates[0]["score"] > generic_120["score"]
    assert "stronger RMS onset support exists" in generic_120["notes"]


def test_broadly_supported_120_still_ranks_first():
    peak_times = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]

    candidates = analysis_module._score_tempo_candidates_from_peaks(
        peak_times,
        onset_candidate_bpms=[120.0] * 6,
    )

    assert candidates[0]["bpm"] == pytest.approx(120.0, abs=0.1)
    assert candidates[0]["score"] == 1.0
    assert candidates[0]["onset_candidate_support_score"] == 1.0
    assert "dense-peak penalty" not in candidates[0]["notes"]


def test_sandstorm_style_high_tempo_onset_candidates_remain_above_local_128():
    peak_times = [0.0, 0.46875, 0.9375, 1.40625, 1.875, 2.34375, 2.8125, 3.28125]

    candidates = analysis_module._score_tempo_candidates_from_peaks(
        peak_times,
        onset_candidate_bpms=[137.1, 137.1, 139.6, 139.6],
    )

    candidate_bpms = [candidate["bpm"] for candidate in candidates]
    assert candidate_bpms[:2] == pytest.approx([137.1, 139.6], abs=0.1)
    assert any(bpm == pytest.approx(128.0, abs=0.1) for bpm in candidate_bpms)
    local_128 = next(candidate for candidate in candidates if candidate["bpm"] == pytest.approx(128.0, abs=0.1))
    assert candidates[0]["score"] > local_128["score"]
    assert candidates[1]["score"] > local_128["score"]


def test_generic_dense_peak_candidate_is_penalized_only_with_better_onset_support():
    peak_times = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]

    local_only = analysis_module._score_tempo_candidates_from_peaks(peak_times, onset_candidate_bpms=[])
    with_better_onset = analysis_module._score_tempo_candidates_from_peaks(
        peak_times,
        onset_candidate_bpms=[106.7, 106.7, 106.7],
    )

    local_only_120 = next(candidate for candidate in local_only if candidate["bpm"] == pytest.approx(120.0, abs=0.1))
    penalized_120 = next(candidate for candidate in with_better_onset if candidate["bpm"] == pytest.approx(120.0, abs=0.1))
    assert "dense-peak penalty" not in local_only_120["notes"]
    assert "dense-peak penalty" in penalized_120["notes"]
    assert penalized_120["score"] < local_only_120["score"]


def test_tempo_candidates_include_onset_candidate_when_local_peaks_show_80_and_120():
    peak_times = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 3.75, 4.5, 5.25]

    tempo_debug = analysis_module._tempo_candidates_debug(
        peak_times,
        accepted_bpm=None,
        onset_candidate_bpms=[106.7],
    )

    candidate_bpms = [candidate["bpm"] for candidate in tempo_debug["candidate_bpms"]]
    assert any(bpm == pytest.approx(106.7, abs=0.1) for bpm in candidate_bpms)
    onset_candidate = next(candidate for candidate in tempo_debug["candidate_bpms"] if candidate["bpm"] == pytest.approx(106.7, abs=0.1))
    assert "rms_onset_candidates" in onset_candidate["source"]
    assert onset_candidate["onset_candidate_support_score"] > 0


def test_rejected_bpm_branch_merges_normalized_onset_candidates_into_tempo_debug():
    rms_values = [0.0] * 50
    for index in [8, 16, 25, 32, 44]:
        rms_values[index] = 1.0

    bpm_analysis = analysis_module._estimate_bpm(rms_values, window_size_seconds=0.0625)

    assert bpm_analysis.estimate is None
    assert bpm_analysis.debug["status"] == "rejected"
    assert bpm_analysis.debug["candidate_bpms"] == [120.0, 106.7, 137.1, 80.0]
    candidate_bpms = [candidate["bpm"] for candidate in bpm_analysis.tempo_candidates_debug["candidate_bpms"]]
    assert any(bpm == pytest.approx(106.7, abs=0.1) for bpm in candidate_bpms)
    assert any(bpm == pytest.approx(137.1, abs=0.1) for bpm in candidate_bpms)
    onset_candidate = next(
        candidate for candidate in bpm_analysis.tempo_candidates_debug["candidate_bpms"] if candidate["bpm"] == pytest.approx(106.7, abs=0.1)
    )
    assert "rms_onset_candidates" in onset_candidate["source"]


def test_tempo_candidates_include_accepted_bpm_and_merge_sources():
    peak_times = [0.0, 0.5, 1.0, 1.5, 2.0]

    tempo_debug = analysis_module._tempo_candidates_debug(
        peak_times,
        accepted_bpm=137.1,
        onset_candidate_bpms=[137.1, 137.1, 137.1],
    )

    candidate = next(candidate for candidate in tempo_debug["candidate_bpms"] if candidate["bpm"] == pytest.approx(137.1, abs=0.1))
    assert "accepted_bpm" in candidate["source"]
    assert "rms_onset_candidates" in candidate["source"]
    assert tempo_debug["top_candidate_bpm"] == pytest.approx(137.1, abs=0.1)


def test_half_tempo_pulse_pattern_normalizes_into_dance_range(tmp_path):
    audio_path = tmp_path / "pulse-60.wav"
    write_pulse_wav(audio_path, bpm=60, beat_count=10)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.estimated_bpm == pytest.approx(120.0, abs=1.0)
    assert result.sidecar.analysis.estimated_bpm_source == "rms_onset_interval"


def test_flat_silence_returns_null_bpm(tmp_path):
    audio_path = tmp_path / "silence.wav"
    write_silent_wav(audio_path, duration_seconds=4.0)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.estimated_bpm is None
    assert result.sidecar.analysis.estimated_bpm_confidence is None
    assert result.sidecar.analysis.estimated_bpm_source is None
    assert result.sidecar.analysis.bpm_debug is not None
    assert result.sidecar.analysis.bpm_debug["status"] == "rejected"
    assert "below the minimum threshold" in result.sidecar.analysis.bpm_debug["reason"]
    assert result.sidecar.analysis.bpm_debug["candidate_bpms"] == []
    assert result.sidecar.analysis.beat_debug is not None
    assert result.sidecar.analysis.beat_debug["status"] == "rejected"
    assert "below the minimum threshold" in result.sidecar.analysis.beat_debug["reason"]


def test_flat_steady_tone_returns_null_bpm(tmp_path):
    audio_path = tmp_path / "steady.wav"
    write_tone_wav(audio_path, amplitude=0.5, duration_seconds=4.0)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.estimated_bpm is None
    assert result.sidecar.analysis.estimated_bpm_confidence is None
    assert result.sidecar.analysis.estimated_bpm_source is None
    assert result.sidecar.analysis.bpm_debug is not None
    assert result.sidecar.analysis.bpm_debug["status"] == "rejected"
    assert "too small" in result.sidecar.analysis.bpm_debug["reason"]
    assert result.sidecar.analysis.beat_debug is not None
    assert result.sidecar.analysis.beat_debug["status"] == "rejected"
    assert "too small" in result.sidecar.analysis.beat_debug["reason"]


def test_irregular_pulse_pattern_returns_null_bpm(tmp_path):
    audio_path = tmp_path / "irregular.wav"
    write_segmented_wav(
        audio_path,
        [
            ("tone", 0.1, 0.8),
            ("silence", 0.3, 0.0),
            ("tone", 0.1, 0.8),
            ("silence", 0.8, 0.0),
            ("tone", 0.1, 0.8),
            ("silence", 0.5, 0.0),
            ("tone", 0.1, 0.8),
            ("silence", 1.1, 0.0),
            ("tone", 0.1, 0.8),
        ],
    )

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.estimated_bpm is None
    assert result.sidecar.analysis.estimated_bpm_confidence is None
    assert result.sidecar.analysis.bpm_debug is not None
    assert result.sidecar.analysis.bpm_debug["status"] in {"rejected", "insufficient_onsets"}
    assert result.sidecar.analysis.beat_debug is not None
    assert result.sidecar.analysis.beat_debug["status"] in {"rejected", "insufficient_onsets"}


def test_bpm_debug_does_not_change_existing_cue_timestamps(tmp_path):
    audio_path = tmp_path / "delayed-tone.wav"
    write_silence_then_tone_wav(audio_path, silence_seconds=0.5, tone_seconds=0.5)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert [(cue.label, cue.time_seconds) for cue in result.sidecar.cues] == [("intro", 0.5)]
    assert result.sidecar.analysis.bpm_debug is not None
    assert result.sidecar.analysis.beat_debug is not None
    assert result.sidecar.analysis.tempo_candidates_debug is not None


def test_steady_tone_does_not_create_energy_shift_cues(tmp_path):
    audio_path = tmp_path / "steady-tone.wav"
    write_tone_wav(audio_path, amplitude=0.5, duration_seconds=2.0)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert "energy_shift" not in [cue.label for cue in result.sidecar.cues]


def test_silence_only_file_does_not_create_energy_shift_cues(tmp_path):
    audio_path = tmp_path / "silence.wav"
    write_silent_wav(audio_path, duration_seconds=2.0)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert "energy_shift" not in [cue.label for cue in result.sidecar.cues]


def test_low_to_high_energy_transition_creates_energy_shift_near_transition(tmp_path):
    audio_path = tmp_path / "low-high.wav"
    write_segmented_wav(audio_path, [("tone", 1.0, 0.2), ("tone", 1.0, 0.8)])
    settings = AnalysisSettings(energy_shift_min_spacing_seconds=0.25, minimum_outro_track_duration_seconds=10.0)

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    shifts = [cue for cue in result.sidecar.cues if cue.label == "energy_shift"]
    assert len(shifts) == 1
    assert 0.9 <= shifts[0].time_seconds <= 1.1
    assert shifts[0].confidence == 0.25
    assert "energy rise" in shifts[0].reason
    assert shifts[0].metadata is not None
    assert shifts[0].metadata["heuristic"] == "rms_energy_shift"
    assert shifts[0].metadata["direction"] == "rise"
    assert shifts[0].metadata["delta"] > 0


def test_high_to_low_energy_transition_creates_energy_shift_near_transition(tmp_path):
    audio_path = tmp_path / "high-low.wav"
    write_segmented_wav(audio_path, [("tone", 1.0, 0.8), ("tone", 1.0, 0.2)])
    settings = AnalysisSettings(energy_shift_min_spacing_seconds=0.25, minimum_outro_track_duration_seconds=10.0)

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    shifts = [cue for cue in result.sidecar.cues if cue.label == "energy_shift"]
    assert len(shifts) == 1
    assert 0.9 <= shifts[0].time_seconds <= 1.1
    assert "energy drop" in shifts[0].reason
    assert "not beat- or phrase-aware" in shifts[0].reason
    assert shifts[0].metadata is not None
    assert shifts[0].metadata["heuristic"] == "rms_energy_shift"
    assert shifts[0].metadata["direction"] == "drop"
    assert shifts[0].metadata["delta"] > 0


def test_energy_shift_cue_required_fields_remain_label_time_confidence_reason(tmp_path):
    audio_path = tmp_path / "low-high.wav"
    write_segmented_wav(audio_path, [("tone", 1.0, 0.2), ("tone", 1.0, 0.8)])
    settings = AnalysisSettings(energy_shift_min_spacing_seconds=0.25, minimum_outro_track_duration_seconds=10.0)

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    shifts = [cue.to_dict() for cue in result.sidecar.cues if cue.label == "energy_shift"]
    assert len(shifts) == 1
    assert {"label", "time_seconds", "confidence", "reason"}.issubset(shifts[0])
    assert shifts[0]["metadata"]["direction"] == "rise"


def test_multiple_energy_transitions_are_capped_at_three_cues(tmp_path):
    audio_path = tmp_path / "many-shifts.wav"
    write_segmented_wav(
        audio_path,
        [
            ("tone", 0.5, 0.2),
            ("tone", 0.5, 0.8),
            ("tone", 0.5, 0.2),
            ("tone", 0.5, 0.8),
            ("tone", 0.5, 0.2),
            ("tone", 0.5, 0.8),
        ],
    )
    settings = AnalysisSettings(energy_shift_min_spacing_seconds=0.25, minimum_outro_track_duration_seconds=10.0)

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    shifts = [cue for cue in result.sidecar.cues if cue.label == "energy_shift"]
    assert len(shifts) == 3


def test_max_energy_shift_cues_limits_generated_energy_shift_cues(tmp_path):
    audio_path = tmp_path / "many-shifts.wav"
    write_segmented_wav(
        audio_path,
        [
            ("tone", 0.5, 0.2),
            ("tone", 0.5, 0.8),
            ("tone", 0.5, 0.2),
            ("tone", 0.5, 0.8),
            ("tone", 0.5, 0.2),
            ("tone", 0.5, 0.8),
        ],
    )
    settings = AnalysisSettings(
        energy_shift_min_spacing_seconds=0.25,
        minimum_outro_track_duration_seconds=10.0,
        max_energy_shift_cues=2,
    )

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    shifts = [cue for cue in result.sidecar.cues if cue.label == "energy_shift"]
    assert len(shifts) == 2


def test_energy_shift_is_not_duplicated_too_close_to_intro_or_outro(tmp_path):
    audio_path = tmp_path / "intro-shift.wav"
    write_silence_then_tone_wav(audio_path, silence_seconds=0.5, tone_seconds=0.5)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert [cue.label for cue in result.sidecar.cues] == ["intro"]


def test_custom_settings_change_window_size_and_confidence(tmp_path):
    audio_path = tmp_path / "delayed-tone.wav"
    write_silence_then_tone_wav(audio_path, silence_seconds=0.4, tone_seconds=0.6)
    settings = AnalysisSettings(
        energy_window_seconds=0.1,
        intro_confidence=0.12,
        outro_confidence=0.22,
        minimum_outro_track_duration_seconds=0.5,
    )

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    assert result.sidecar.analysis.energy_summary is not None
    assert result.sidecar.analysis.energy_summary.window_size_seconds == 0.1
    cues_by_label = {cue.label: cue for cue in result.sidecar.cues}
    assert cues_by_label["intro"].confidence == 0.12
    assert cues_by_label["outro"].confidence == 0.22


def test_custom_sustained_window_count_can_suppress_short_energy_regions(tmp_path):
    audio_path = tmp_path / "short-energy.wav"
    write_silence_then_tone_wav(audio_path, silence_seconds=0.5, tone_seconds=0.5)
    settings = AnalysisSettings(sustained_window_count=3)

    result = analyze_audio(audio_path, settings=settings)

    assert result.sidecar is not None
    assert result.sidecar.cues == []


def test_analysis_profile_helper_returns_expected_settings():
    assert get_analysis_settings_profile("balanced") == AnalysisSettings()
    assert get_analysis_settings_profile(AnalysisProfile.BALANCED) == AnalysisSettings()
    conservative = get_analysis_settings_profile("conservative")
    sensitive = get_analysis_settings_profile("sensitive")
    assert conservative.silence_threshold > AnalysisSettings().silence_threshold
    assert conservative.sustained_window_count > AnalysisSettings().sustained_window_count
    assert conservative.energy_shift_min_delta > AnalysisSettings().energy_shift_min_delta
    assert conservative.max_energy_shift_cues == 2
    assert conservative.outro_search_last_fraction < AnalysisSettings().outro_search_last_fraction
    assert conservative.outro_search_last_seconds < AnalysisSettings().outro_search_last_seconds
    assert sensitive.silence_threshold < AnalysisSettings().silence_threshold
    assert sensitive.sustained_window_count < AnalysisSettings().sustained_window_count
    assert sensitive.energy_shift_min_delta < AnalysisSettings().energy_shift_min_delta
    assert sensitive.max_energy_shift_cues == 3
    assert sensitive.outro_search_last_fraction > AnalysisSettings().outro_search_last_fraction
    assert sensitive.outro_search_last_seconds > AnalysisSettings().outro_search_last_seconds


def test_analysis_profile_helper_rejects_unknown_profile():
    with pytest.raises(ValueError):
        get_analysis_settings_profile("unknown")


def test_non_wav_decode_path_calls_ffmpeg_and_analyzes_temporary_wav(tmp_path, monkeypatch):
    audio_path = tmp_path / "track.mp3"
    audio_path.write_bytes(b"fake mp3 bytes")
    calls = []
    decoded_paths = []

    def fake_run(command, capture_output, text, check):
        calls.append(command)
        decoded_path = Path(command[-1])
        decoded_paths.append(decoded_path)
        write_tone_wav(decoded_path, channels=2, duration_seconds=0.5)

    monkeypatch.setattr(analysis_module.subprocess, "run", fake_run)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert calls
    assert calls[0][0] == "ffmpeg"
    assert str(audio_path) in calls[0]
    assert "-acodec" in calls[0]
    assert "pcm_s16le" in calls[0]
    assert result.sidecar.source_file == "track.mp3"
    assert result.sidecar.analysis.duration_seconds == 0.5
    assert result.sidecar.analysis.energy_summary is not None
    assert result.sidecar.warnings == ["Temporary ffmpeg decode used for WAV analysis; source audio was not modified."]
    assert decoded_paths
    assert not decoded_paths[0].exists()


def test_ffmpeg_missing_for_non_wav_creates_safe_placeholder(tmp_path, monkeypatch):
    audio_path = tmp_path / "track.m4a"
    audio_path.write_bytes(b"fake m4a bytes")

    def fake_run(command, capture_output, text, check):
        raise FileNotFoundError

    monkeypatch.setattr(analysis_module.subprocess, "run", fake_run)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.duration_seconds is None
    assert result.sidecar.analysis.energy_summary is None
    assert result.sidecar.cues == []
    assert result.sidecar.warnings == [
        "ffmpeg was not found; duration, energy, and cue detection are unavailable for .m4a files."
    ]


def test_ffmpeg_failure_for_non_wav_creates_safe_placeholder(tmp_path, monkeypatch):
    audio_path = tmp_path / "track.flac"
    audio_path.write_bytes(b"fake flac bytes")

    def fake_run(command, capture_output, text, check):
        raise subprocess.CalledProcessError(1, command, stderr="decode failed")

    monkeypatch.setattr(analysis_module.subprocess, "run", fake_run)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.duration_seconds is None
    assert result.sidecar.analysis.energy_summary is None
    assert result.sidecar.warnings == [
        "ffmpeg decoding failed for .flac file; duration, energy, and cue detection are unavailable. "
        "Detail: decode failed"
    ]


def test_ffmpeg_executable_access_failure_creates_safe_placeholder(tmp_path, monkeypatch):
    audio_path = tmp_path / "track.flac"
    audio_path.write_bytes(b"synthetic invalid FLAC")

    def unavailable_ffmpeg(*args, **kwargs):
        raise OSError(22, "The file cannot be accessed by the system")

    monkeypatch.setattr(analysis_module.subprocess, "run", unavailable_ffmpeg)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.duration_seconds is None
    assert result.sidecar.cues == []
    assert "ffmpeg could not be started" in result.sidecar.warnings[0]


def test_non_wav_ffmpeg_decode_does_not_modify_source_file(tmp_path, monkeypatch):
    audio_path = tmp_path / "track.aiff"
    audio_path.write_bytes(b"fake aiff bytes")
    original_bytes = audio_path.read_bytes()
    original_stat = audio_path.stat()

    def fake_run(command, capture_output, text, check):
        write_tone_wav(command[-1], duration_seconds=0.25)

    monkeypatch.setattr(analysis_module.subprocess, "run", fake_run)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert audio_path.read_bytes() == original_bytes
    assert audio_path.stat().st_size == original_stat.st_size
    assert audio_path.stat().st_mtime_ns == original_stat.st_mtime_ns


def test_wav_analysis_does_not_use_ffmpeg(tmp_path, monkeypatch):
    audio_path = tmp_path / "track.wav"
    write_silent_wav(audio_path, duration_seconds=0.1)

    def fake_run(command, capture_output, text, check):
        raise AssertionError("ffmpeg should not be called for WAV files")

    monkeypatch.setattr(analysis_module.subprocess, "run", fake_run)

    result = analyze_audio(audio_path)

    assert result.sidecar is not None
    assert result.sidecar.analysis.duration_seconds == 0.1
