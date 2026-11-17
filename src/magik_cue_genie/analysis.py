from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from pathlib import Path
import struct
import subprocess
import tempfile
from typing import Any
import wave

from .models import AnalysisSummary, CueSuggestion, EnergySummary, SkippedFile, TrackSidecar


MAX_ENVELOPE_POINTS = 200
MAX_INT16 = 32768.0
INTRO_MIN_ABSOLUTE_RMS = 0.01
INTRO_SEARCH_SECONDS = 30.0
OUTRO_MIN_ABSOLUTE_RMS = 0.01
OUTRO_LOOKBACK_SECONDS = 0.5
BPM_MIN = 70.0
BPM_MAX = 180.0
BPM_CONFIDENCE_THRESHOLD = 0.6
BPM_SOURCE = "rms_onset_interval"


@dataclass(frozen=True)
class AnalysisSettings:
    energy_window_seconds: float = 0.25
    silence_threshold: float = 0.2
    sustained_window_count: int = 2
    minimum_outro_track_duration_seconds: float = 1.5
    outro_search_last_fraction: float = 0.35
    outro_search_last_seconds: float = 90.0
    intro_confidence: float = 0.35
    outro_confidence: float = 0.3
    energy_shift_min_delta: float = 0.45
    energy_shift_min_spacing_seconds: float = 1.0
    energy_shift_confidence: float = 0.25
    max_energy_shift_cues: int = 3

    def to_dict(self) -> dict[str, float | int]:
        return {
            "energy_window_seconds": self.energy_window_seconds,
            "silence_threshold": self.silence_threshold,
            "sustained_window_count": self.sustained_window_count,
            "minimum_outro_track_duration_seconds": self.minimum_outro_track_duration_seconds,
            "outro_search_last_fraction": self.outro_search_last_fraction,
            "outro_search_last_seconds": self.outro_search_last_seconds,
            "intro_confidence": self.intro_confidence,
            "outro_confidence": self.outro_confidence,
            "energy_shift_min_delta": self.energy_shift_min_delta,
            "energy_shift_min_spacing_seconds": self.energy_shift_min_spacing_seconds,
            "energy_shift_confidence": self.energy_shift_confidence,
            "max_energy_shift_cues": self.max_energy_shift_cues,
        }


class AnalysisProfile(str, Enum):
    CONSERVATIVE = "conservative"
    BALANCED = "balanced"
    SENSITIVE = "sensitive"


def get_analysis_settings_profile(name: str | AnalysisProfile) -> AnalysisSettings:
    profile = AnalysisProfile(name)
    if profile == AnalysisProfile.CONSERVATIVE:
        return AnalysisSettings(
            silence_threshold=0.35,
            sustained_window_count=3,
            energy_shift_min_delta=0.6,
            energy_shift_min_spacing_seconds=1.5,
            energy_shift_confidence=0.2,
            max_energy_shift_cues=2,
            outro_search_last_fraction=0.25,
            outro_search_last_seconds=60.0,
        )
    if profile == AnalysisProfile.SENSITIVE:
        return AnalysisSettings(
            silence_threshold=0.1,
            sustained_window_count=1,
            intro_confidence=0.3,
            outro_confidence=0.25,
            energy_shift_min_delta=0.3,
            energy_shift_min_spacing_seconds=0.5,
            energy_shift_confidence=0.2,
            max_energy_shift_cues=3,
            outro_search_last_fraction=0.45,
            outro_search_last_seconds=120.0,
        )
    return AnalysisSettings()


@dataclass(frozen=True)
class AudioAnalysisResult:
    sidecar: TrackSidecar | None
    warning: str | None = None
    skipped_file: SkippedFile | None = None


@dataclass(frozen=True)
class BpmEstimate:
    bpm: float
    confidence: float
    source: str = BPM_SOURCE


@dataclass(frozen=True)
class BpmAnalysis:
    estimate: BpmEstimate | None
    debug: dict[str, Any]
    beat_debug: dict[str, Any]
    tempo_candidates_debug: dict[str, Any]


def analyze_audio(audio_path: Path, settings: AnalysisSettings | None = None) -> AudioAnalysisResult:
    settings = settings or AnalysisSettings()
    if audio_path.suffix.lower() != ".wav":
        return _analyze_non_wav_with_ffmpeg(audio_path, settings)

    try:
        duration_seconds, energy_summary, bpm_analysis = _analyze_wav(audio_path, settings)
    except (EOFError, wave.Error) as error:
        skipped_file = SkippedFile(
            source_file=audio_path.name,
            reason="Malformed WAV file",
            detail=str(error),
        )
        return AudioAnalysisResult(sidecar=None, skipped_file=skipped_file)

    return _audio_analysis_result_for_wav_data(audio_path.name, duration_seconds, energy_summary, settings, bpm_analysis)


def _analyze_non_wav_with_ffmpeg(audio_path: Path, settings: AnalysisSettings) -> AudioAnalysisResult:
    with tempfile.TemporaryDirectory(prefix="magik-cue-genie-") as temp_dir:
        decoded_wav_path = Path(temp_dir) / f"{audio_path.stem}.decoded.wav"
        try:
            _decode_to_temporary_wav(audio_path, decoded_wav_path)
            duration_seconds, energy_summary, bpm_analysis = _analyze_wav(decoded_wav_path, settings)
        except FileNotFoundError:
            warning = (
                f"ffmpeg was not found; duration, energy, and cue detection are unavailable "
                f"for {audio_path.suffix.lower()} files."
            )
            return AudioAnalysisResult(sidecar=TrackSidecar.placeholder_for(audio_path, warnings=[warning]), warning=warning)
        except subprocess.CalledProcessError as error:
            detail = _subprocess_error_detail(error)
            warning = (
                f"ffmpeg decoding failed for {audio_path.suffix.lower()} file; duration, energy, "
                f"and cue detection are unavailable."
            )
            if detail:
                warning = f"{warning} Detail: {detail}"
            return AudioAnalysisResult(sidecar=TrackSidecar.placeholder_for(audio_path, warnings=[warning]), warning=warning)
        except (EOFError, wave.Error) as error:
            warning = (
                f"ffmpeg decoded {audio_path.suffix.lower()} file, but WAV analysis failed; "
                f"duration, energy, and cue detection are unavailable. Detail: {error}"
            )
            return AudioAnalysisResult(sidecar=TrackSidecar.placeholder_for(audio_path, warnings=[warning]), warning=warning)

        warning = "Temporary ffmpeg decode used for WAV analysis; source audio was not modified."
        return _audio_analysis_result_for_wav_data(
            audio_path.name,
            duration_seconds,
            energy_summary,
            settings,
            bpm_analysis=bpm_analysis,
            warnings=[warning],
            warning=warning,
        )


def _decode_to_temporary_wav(audio_path: Path, decoded_wav_path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(audio_path),
            "-acodec",
            "pcm_s16le",
            "-ac",
            "2",
            str(decoded_wav_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )


def _subprocess_error_detail(error: subprocess.CalledProcessError) -> str:
    stderr = error.stderr.strip() if isinstance(error.stderr, str) else ""
    stdout = error.stdout.strip() if isinstance(error.stdout, str) else ""
    return stderr or stdout


def _audio_analysis_result_for_wav_data(
    source_file: str,
    duration_seconds: float,
    energy_summary: EnergySummary,
    settings: AnalysisSettings,
    bpm_analysis: BpmAnalysis | None = None,
    warnings: list[str] | None = None,
    warning: str | None = None,
) -> AudioAnalysisResult:
    cues, cue_warnings = _suggest_cues(energy_summary, duration_seconds, settings)
    all_warnings = [*(warnings or []), *cue_warnings]
    bpm_estimate = bpm_analysis.estimate if bpm_analysis else None
    return AudioAnalysisResult(
        sidecar=TrackSidecar(
            source_file=source_file,
            analysis=AnalysisSummary(
                duration_seconds=duration_seconds,
                estimated_bpm=bpm_estimate.bpm if bpm_estimate else None,
                estimated_bpm_confidence=bpm_estimate.confidence if bpm_estimate else None,
                estimated_bpm_source=bpm_estimate.source if bpm_estimate else None,
                bpm_debug=bpm_analysis.debug if bpm_analysis else None,
                beat_debug=bpm_analysis.beat_debug if bpm_analysis else None,
                tempo_candidates_debug=bpm_analysis.tempo_candidates_debug if bpm_analysis else None,
                energy_summary=energy_summary,
            ),
            cues=cues,
            warnings=all_warnings,
        ),
        warning=warning,
    )


def _analyze_wav(audio_path: Path, settings: AnalysisSettings) -> tuple[float, EnergySummary, BpmAnalysis]:
    with wave.open(str(audio_path), "rb") as wav_file:
        frame_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        channel_count = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        compression = wav_file.getcomptype()

        if frame_rate <= 0:
            raise wave.Error("WAV sample rate must be greater than zero")
        if sample_width != 2:
            raise wave.Error("only 16-bit PCM WAV files are supported for energy analysis")
        if channel_count not in {1, 2}:
            raise wave.Error("only mono and stereo WAV files are supported for energy analysis")
        if compression != "NONE":
            raise wave.Error("only uncompressed PCM WAV files are supported for energy analysis")

        duration_seconds = frame_count / frame_rate
        window_frames = max(1, int(frame_rate * settings.energy_window_seconds))
        rms_values = _read_window_rms_values(wav_file, channel_count, window_frames)

    return duration_seconds, _summarize_energy(rms_values, settings), _estimate_bpm(rms_values, settings.energy_window_seconds)


def _read_window_rms_values(
    wav_file: wave.Wave_read,
    channel_count: int,
    window_frames: int,
) -> list[float]:
    rms_values: list[float] = []
    while True:
        frame_bytes = wav_file.readframes(window_frames)
        if not frame_bytes:
            break

        sample_count = len(frame_bytes) // 2
        if sample_count == 0:
            continue

        squares_sum = 0
        for (sample,) in struct.iter_unpack("<h", frame_bytes[: sample_count * 2]):
            squares_sum += sample * sample

        sample_count = sample_count // channel_count * channel_count
        if sample_count:
            rms_values.append(math.sqrt(squares_sum / sample_count) / MAX_INT16)

    return rms_values


def _summarize_energy(rms_values: list[float], settings: AnalysisSettings) -> EnergySummary:
    if not rms_values:
        return EnergySummary(
            window_size_seconds=settings.energy_window_seconds,
            max_rms=0.0,
            mean_rms=0.0,
            normalized_envelope=[],
        )

    max_rms = max(rms_values)
    mean_rms = sum(rms_values) / len(rms_values)
    envelope_values = _downsample(rms_values, MAX_ENVELOPE_POINTS)
    normalized_envelope = [round(value / max_rms, 6) if max_rms else 0.0 for value in envelope_values]
    return EnergySummary(
        window_size_seconds=settings.energy_window_seconds,
        max_rms=round(max_rms, 6),
        mean_rms=round(mean_rms, 6),
        normalized_envelope=normalized_envelope,
    )


def _estimate_bpm(rms_values: list[float], window_size_seconds: float) -> BpmAnalysis:
    peak_times: list[float] = []
    base_debug = _bpm_debug(
        status="rejected",
        onset_times=[],
        intervals=[],
        candidate_bpms=[],
        selected_bpm=None,
        confidence=None,
        reason="BPM estimate rejected before onset analysis.",
    )
    base_beat_debug = _beat_debug(
        status="rejected",
        onset_times=[],
        peak_times=[],
        intervals=[],
        candidate_bpms=[],
        selected_interval=None,
        selected_bpm=None,
        confidence=None,
        reason="BPM estimate rejected before onset analysis.",
    )
    base_tempo_debug = _tempo_candidates_debug(
        peak_times=[],
        accepted_bpm=None,
        reason="Tempo candidate analysis rejected before local peak analysis.",
    )
    if len(rms_values) < 8 or window_size_seconds <= 0:
        return BpmAnalysis(
            estimate=None,
            debug={**base_debug, "reason": "Not enough RMS windows for BPM estimation."},
            beat_debug={**base_beat_debug, "reason": "Not enough RMS windows for beat/onset diagnostics."},
            tempo_candidates_debug={
                **base_tempo_debug,
                "reason": "Not enough RMS windows for tempo candidate diagnostics.",
            },
        )

    max_rms = max(rms_values)
    if max_rms < INTRO_MIN_ABSOLUTE_RMS:
        return BpmAnalysis(
            estimate=None,
            debug={**base_debug, "reason": "RMS energy is below the minimum threshold for BPM estimation."},
            beat_debug={**base_beat_debug, "reason": "RMS energy is below the minimum threshold for beat/onset diagnostics."},
            tempo_candidates_debug={
                **base_tempo_debug,
                "reason": "RMS energy is below the minimum threshold for tempo candidate diagnostics.",
            },
        )

    positive_deltas = [max(0.0, rms_values[index] - rms_values[index - 1]) for index in range(1, len(rms_values))]
    max_delta = max(positive_deltas, default=0.0)
    peak_times = _detect_peak_times(rms_values, max_rms, window_size_seconds)
    tempo_debug_without_estimate = _tempo_candidates_debug(peak_times, accepted_bpm=None, onset_candidate_bpms=[])
    if max_delta < max_rms * 0.35:
        return BpmAnalysis(
            estimate=None,
            debug={**base_debug, "reason": "RMS onset changes are too small for BPM estimation."},
            beat_debug={
                **base_beat_debug,
                "local_peak_times_seconds": [round(value, 3) for value in peak_times],
                "reason": "RMS onset changes are too small for beat/onset diagnostics.",
            },
            tempo_candidates_debug=_tempo_candidates_debug(
                peak_times,
                accepted_bpm=None,
                onset_candidate_bpms=[],
            ),
        )

    onset_threshold = max_delta * 0.5
    onsets = _detect_onset_times(rms_values, positive_deltas, onset_threshold, max_rms, window_size_seconds)
    if len(onsets) < 4:
        return BpmAnalysis(
            estimate=None,
            debug=_bpm_debug(
                status="insufficient_onsets",
                onset_times=onsets,
                intervals=[],
                candidate_bpms=[],
                selected_bpm=None,
                confidence=None,
                reason="Fewer than four onset candidates were detected.",
            ),
            beat_debug=_beat_debug(
                status="insufficient_onsets",
                onset_times=onsets,
                peak_times=peak_times,
                intervals=[],
                candidate_bpms=[],
                selected_interval=None,
                selected_bpm=None,
                confidence=None,
                reason="Fewer than four onset candidates were detected.",
            ),
            tempo_candidates_debug=_tempo_candidates_debug(
                peak_times,
                accepted_bpm=None,
                onset_candidate_bpms=[],
            ),
        )

    candidates = []
    intervals = []
    for previous, current in zip(onsets, onsets[1:]):
        interval = current - previous
        if interval <= 0:
            continue
        intervals.append(interval)
        bpm = _normalize_bpm_to_dance_range(60 / interval)
        if BPM_MIN <= bpm <= BPM_MAX:
            candidates.append(bpm)

    if len(candidates) < 3:
        return BpmAnalysis(
            estimate=None,
            debug=_bpm_debug(
                status="rejected",
                onset_times=onsets,
                intervals=intervals,
                candidate_bpms=candidates,
                selected_bpm=None,
                confidence=None,
                reason="Fewer than three BPM interval candidates were available.",
            ),
            beat_debug=_beat_debug(
                status="rejected",
                onset_times=onsets,
                peak_times=peak_times,
                intervals=intervals,
                candidate_bpms=candidates,
                selected_interval=None,
                selected_bpm=None,
                confidence=None,
                reason="Fewer than three beat interval candidates were available.",
            ),
            tempo_candidates_debug=_tempo_candidates_debug(
                peak_times,
                accepted_bpm=None,
                onset_candidate_bpms=candidates,
            ),
        )

    median_bpm = _median(candidates)
    matching = [candidate for candidate in candidates if abs(candidate - median_bpm) <= 4.0]
    consistency = len(matching) / len(candidates)
    onset_support = min(1.0, len(onsets) / 8)
    confidence = round(consistency * onset_support, 3)
    if confidence < BPM_CONFIDENCE_THRESHOLD:
        return BpmAnalysis(
            estimate=None,
            debug=_bpm_debug(
                status="rejected",
                onset_times=onsets,
                intervals=intervals,
                candidate_bpms=candidates,
                selected_bpm=None,
                confidence=confidence,
                reason="BPM interval candidates were not consistent enough.",
            ),
            beat_debug=_beat_debug(
                status="rejected",
                onset_times=onsets,
                peak_times=peak_times,
                intervals=intervals,
                candidate_bpms=candidates,
                selected_interval=60 / median_bpm if median_bpm else None,
                selected_bpm=None,
                confidence=confidence,
                reason="Beat interval candidates were not consistent enough.",
            ),
            tempo_candidates_debug=_tempo_candidates_debug(
                peak_times,
                accepted_bpm=None,
                onset_candidate_bpms=candidates,
            ),
        )

    bpm = round(_median(matching), 1)
    selected_interval = 60 / bpm if bpm else None
    return BpmAnalysis(
        estimate=BpmEstimate(bpm=bpm, confidence=confidence),
        debug=_bpm_debug(
            status="accepted",
            onset_times=onsets,
            intervals=intervals,
            candidate_bpms=candidates,
            selected_bpm=bpm,
            confidence=confidence,
            reason="Stable RMS onset intervals produced a BPM estimate.",
        ),
        beat_debug=_beat_debug(
            status="accepted",
            onset_times=onsets,
            peak_times=peak_times,
            intervals=intervals,
            candidate_bpms=candidates,
            selected_interval=selected_interval,
            selected_bpm=bpm,
            confidence=confidence,
            reason="Stable RMS onset intervals produced beat timing diagnostics.",
        ),
        tempo_candidates_debug=_tempo_candidates_debug(peak_times, accepted_bpm=bpm, onset_candidate_bpms=candidates),
    )


def _bpm_debug(
    status: str,
    onset_times: list[float],
    intervals: list[float],
    candidate_bpms: list[float],
    selected_bpm: float | None,
    confidence: float | None,
    reason: str,
) -> dict[str, Any]:
    return {
        "source": BPM_SOURCE,
        "status": status,
        "onset_times_seconds": [round(value, 3) for value in onset_times],
        "intervals_seconds": [round(value, 3) for value in intervals],
        "candidate_bpms": [round(value, 1) for value in candidate_bpms],
        "selected_bpm": selected_bpm,
        "confidence": confidence,
        "reason": reason,
    }


def _beat_debug(
    status: str,
    onset_times: list[float],
    peak_times: list[float],
    intervals: list[float],
    candidate_bpms: list[float],
    selected_interval: float | None,
    selected_bpm: float | None,
    confidence: float | None,
    reason: str,
) -> dict[str, Any]:
    return {
        "source": "rms_onset_interval",
        "status": status,
        "onset_times_seconds": [round(value, 3) for value in onset_times],
        "local_peak_times_seconds": [round(value, 3) for value in peak_times],
        "candidate_beat_intervals_seconds": [round(value, 3) for value in intervals],
        "normalized_candidate_bpms": [round(value, 1) for value in candidate_bpms],
        "selected_beat_interval_seconds": round(selected_interval, 3) if selected_interval is not None else None,
        "selected_bpm": selected_bpm,
        "confidence": confidence,
        "reason": reason,
    }


def _detect_peak_times(rms_values: list[float], max_rms: float, window_size_seconds: float) -> list[float]:
    if len(rms_values) < 3 or max_rms <= 0:
        return []

    peak_times = []
    min_spacing_seconds = 60 / BPM_MAX
    threshold = max_rms * 0.5
    for index in range(1, len(rms_values) - 1):
        value = rms_values[index]
        if value < threshold:
            continue
        if value < rms_values[index - 1] or value < rms_values[index + 1]:
            continue

        peak_time = index * window_size_seconds
        if peak_times and peak_time - peak_times[-1] < min_spacing_seconds:
            continue
        peak_times.append(peak_time)
    return peak_times


def _tempo_candidates_debug(
    peak_times: list[float],
    accepted_bpm: float | None,
    onset_candidate_bpms: list[float] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    candidates = _score_tempo_candidates_from_peaks(peak_times, onset_candidate_bpms or [], accepted_bpm)
    top_candidate = candidates[0] if candidates else None
    confidence = top_candidate["score"] if top_candidate else None
    status = "accepted" if top_candidate and confidence is not None and confidence >= 0.45 else "rejected"
    agreement = _tempo_candidate_agreement(top_candidate["bpm"] if top_candidate else None, accepted_bpm)
    if reason is None:
        if top_candidate:
            reason = "Repeated local energy peak intervals produced tempo candidates."
        else:
            reason = "Not enough repeated local energy peak intervals for tempo candidates."
    return {
        "source": "local_energy_peaks",
        "status": status,
        "local_peak_count": len(peak_times),
        "candidate_bpms": candidates,
        "top_candidate_bpm": top_candidate["bpm"] if top_candidate else None,
        "top_candidate_confidence": confidence,
        "estimated_bpm_agreement": agreement,
        "reason": reason,
    }


def _score_tempo_candidates_from_peaks(
    peak_times: list[float],
    onset_candidate_bpms: list[float] | None = None,
    accepted_bpm: float | None = None,
) -> list[dict[str, Any]]:
    onset_candidate_bpms = onset_candidate_bpms or []
    min_interval_seconds = 60 / BPM_MAX
    max_interval_seconds = 60 / BPM_MIN
    grouped: list[dict[str, Any]] = []
    if len(peak_times) >= 4:
        for left_index, start_time in enumerate(peak_times[:-1]):
            for end_time in peak_times[left_index + 1 : min(len(peak_times), left_index + 5)]:
                interval = end_time - start_time
                if interval < min_interval_seconds or interval > max_interval_seconds:
                    continue

                bpm = round(_normalize_bpm_to_dance_range(60 / interval), 1)
                if not BPM_MIN <= bpm <= BPM_MAX:
                    continue
                _add_tempo_candidate(grouped, bpm, interval)

    scored = []
    for candidate in grouped:
        count = candidate["count"]
        intervals = candidate["intervals"]
        mean_interval = sum(intervals) / len(intervals)
        bpm = round(candidate["bpm_sum"] / count, 1)
        local_peak_count_score = min(1.0, count / 8)
        interval_stability_score = _tempo_interval_stability_score(intervals, mean_interval)
        onset_candidate_support_score = _onset_candidate_support_score(bpm, onset_candidate_bpms)
        score = (
            (local_peak_count_score * 0.25)
            + (interval_stability_score * 0.45)
            + (onset_candidate_support_score * 0.3)
        )
        notes = [
            f"mean interval {mean_interval:.3f}s from repeated local energy peaks",
            f"local peak count score {local_peak_count_score:.2f}",
            f"stability {interval_stability_score:.2f}",
        ]
        if onset_candidate_support_score > 0:
            notes.append("also supported by RMS onset BPM candidates")
        else:
            notes.append("no matching RMS onset BPM candidate")
        _merge_tempo_candidate(
            scored,
            bpm=bpm,
            count=count,
            score=score,
            local_peak_count_score=local_peak_count_score,
            onset_candidate_support_score=onset_candidate_support_score,
            interval_stability_score=interval_stability_score,
            source="local_energy_peaks",
            notes=notes,
            priority=1,
        )

    onset_candidate_counts: dict[float, int] = {}
    for onset_bpm in onset_candidate_bpms:
        rounded_bpm = round(onset_bpm, 1)
        onset_candidate_counts[rounded_bpm] = onset_candidate_counts.get(rounded_bpm, 0) + 1
    for bpm, onset_count in onset_candidate_counts.items():
        if not BPM_MIN <= bpm <= BPM_MAX:
            continue
        onset_support = _onset_candidate_support_score(bpm, onset_candidate_bpms)
        notes = [
            "candidate from RMS onset interval list shared by BPM and beat diagnostics",
            f"onset support {onset_support:.2f}",
        ]
        _merge_tempo_candidate(
            scored,
            bpm=bpm,
            count=onset_count,
            score=(0.5 + (onset_support * 0.4)),
            local_peak_count_score=0.0,
            onset_candidate_support_score=onset_support,
            interval_stability_score=0.0,
            source="rms_onset_candidates",
            notes=notes,
            priority=2,
        )

    if accepted_bpm is not None and BPM_MIN <= accepted_bpm <= BPM_MAX:
        _merge_tempo_candidate(
            scored,
            bpm=round(accepted_bpm, 1),
            count=1,
            score=1.0,
            local_peak_count_score=0.0,
            onset_candidate_support_score=1.0,
            interval_stability_score=1.0,
            source="accepted_bpm",
            notes=["accepted estimated BPM from RMS onset interval analysis"],
            priority=3,
        )
    _rescore_merged_tempo_candidates(scored)
    ranked = sorted(scored, key=lambda candidate: (-candidate["score"], -candidate["count"], candidate["bpm"]))[:5]
    for candidate in ranked:
        candidate.pop("_priority", None)
    return ranked


def _rescore_merged_tempo_candidates(candidates: list[dict[str, Any]]) -> None:
    strongest_onset_support = max(
        (float(candidate["onset_candidate_support_score"]) for candidate in candidates),
        default=0.0,
    )
    for candidate in candidates:
        sources = set(str(candidate["source"]).split("+"))
        local_score = float(candidate["local_peak_count_score"])
        onset_score = float(candidate["onset_candidate_support_score"])
        stability_score = float(candidate["interval_stability_score"])

        if "accepted_bpm" in sources:
            candidate["score"] = 1.0
            continue

        score = (local_score * 0.15) + (stability_score * 0.2) + (onset_score * 0.55)
        if "rms_onset_candidates" in sources:
            score += 0.15

        bpm = float(candidate["bpm"])
        has_better_onset_candidate = strongest_onset_support > onset_score
        if bpm in {80.0, 120.0} and has_better_onset_candidate:
            score *= 0.65
            _append_tempo_candidate_note(
                candidate,
                f"generic {bpm:.0f} BPM dense-peak penalty applied because stronger RMS onset support exists",
            )

        candidate["score"] = round(min(1.0, score), 3)


def _append_tempo_candidate_note(candidate: dict[str, Any], note: str) -> None:
    existing_notes = str(candidate["notes"])
    if note not in existing_notes:
        candidate["notes"] = f"{existing_notes}; {note}"


def _merge_tempo_candidate(
    candidates: list[dict[str, Any]],
    bpm: float,
    count: int,
    score: float,
    local_peak_count_score: float,
    onset_candidate_support_score: float,
    interval_stability_score: float,
    source: str,
    notes: list[str],
    priority: int,
) -> None:
    for candidate in candidates:
        if abs(float(candidate["bpm"]) - bpm) > 0.75:
            continue
        source_set = set(str(candidate["source"]).split("+"))
        source_set.add(source)
        existing_notes = str(candidate["notes"])
        new_notes = [note for note in notes if note not in existing_notes]
        candidate["count"] += count
        candidate["score"] = round(max(float(candidate["score"]), score), 3)
        candidate["local_peak_count_score"] = round(
            max(float(candidate["local_peak_count_score"]), local_peak_count_score),
            3,
        )
        candidate["onset_candidate_support_score"] = round(
            max(float(candidate["onset_candidate_support_score"]), onset_candidate_support_score),
            3,
        )
        candidate["interval_stability_score"] = round(
            max(float(candidate["interval_stability_score"]), interval_stability_score),
            3,
        )
        candidate["source"] = "+".join(sorted(source_set))
        candidate["notes"] = "; ".join([existing_notes, *new_notes]) if new_notes else existing_notes
        if priority > int(candidate["_priority"]):
            candidate["bpm"] = bpm
            candidate["_priority"] = priority
        return

    candidates.append(
        {
            "bpm": bpm,
            "count": count,
            "score": round(score, 3),
            "local_peak_count_score": round(local_peak_count_score, 3),
            "onset_candidate_support_score": round(onset_candidate_support_score, 3),
            "interval_stability_score": round(interval_stability_score, 3),
            "source": source,
            "notes": "; ".join(notes),
            "_priority": priority,
        }
    )


def _tempo_interval_stability_score(intervals: list[float], mean_interval: float) -> float:
    if not intervals or mean_interval <= 0:
        return 0.0
    mean_absolute_deviation = sum(abs(interval - mean_interval) for interval in intervals) / len(intervals)
    relative_deviation = mean_absolute_deviation / mean_interval
    return max(0.0, min(1.0, 1 - (relative_deviation * 6)))


def _onset_candidate_support_score(candidate_bpm: float, onset_candidate_bpms: list[float]) -> float:
    if not onset_candidate_bpms:
        return 0.0
    close_matches = [bpm for bpm in onset_candidate_bpms if abs(bpm - candidate_bpm) <= 1.0]
    if not close_matches:
        return 0.0
    return min(1.0, len(close_matches) / 3)


def _add_tempo_candidate(grouped: list[dict[str, Any]], bpm: float, interval: float) -> None:
    for candidate in grouped:
        if abs((candidate["bpm_sum"] / candidate["count"]) - bpm) <= 1.0:
            candidate["count"] += 1
            candidate["bpm_sum"] += bpm
            candidate["intervals"].append(interval)
            return
    grouped.append({"count": 1, "bpm_sum": bpm, "intervals": [interval]})


def _tempo_candidate_agreement(candidate_bpm: float | None, accepted_bpm: float | None) -> str:
    if candidate_bpm is None:
        return "unknown"
    if accepted_bpm is None:
        return "estimated_bpm_unknown"
    if abs(candidate_bpm - accepted_bpm) <= 2.0:
        return "agrees"
    return "differs"


def _detect_onset_times(
    rms_values: list[float],
    positive_deltas: list[float],
    onset_threshold: float,
    max_rms: float,
    window_size_seconds: float,
) -> list[float]:
    onsets = []
    min_spacing_seconds = 60 / BPM_MAX
    for delta_index, delta in enumerate(positive_deltas):
        rms_index = delta_index + 1
        if delta < onset_threshold:
            continue
        if rms_values[rms_index] < max_rms * 0.4:
            continue

        onset_time = rms_index * window_size_seconds
        if onsets and onset_time - onsets[-1] < min_spacing_seconds:
            continue
        onsets.append(onset_time)
    return onsets


def _normalize_bpm_to_dance_range(bpm: float) -> float:
    while bpm < BPM_MIN:
        bpm *= 2
    while bpm > BPM_MAX:
        bpm /= 2
    return bpm


def _median(values: list[float]) -> float:
    sorted_values = sorted(values)
    midpoint = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return sorted_values[midpoint]
    return (sorted_values[midpoint - 1] + sorted_values[midpoint]) / 2


def _downsample(values: list[float], max_points: int) -> list[float]:
    if len(values) <= max_points:
        return values

    bucket_size = math.ceil(len(values) / max_points)
    return [
        max(values[index : index + bucket_size])
        for index in range(0, len(values), bucket_size)
    ]


def _suggest_cues(
    energy_summary: EnergySummary,
    duration_seconds: float,
    settings: AnalysisSettings,
) -> tuple[list[CueSuggestion], list[str]]:
    if not energy_summary.normalized_envelope:
        return [], ["Cue detection skipped because energy envelope data is unavailable."]

    cues: list[CueSuggestion] = []
    cues.extend(_suggest_intro_cue(energy_summary, settings))
    cues.extend(_suggest_outro_cue(energy_summary, duration_seconds, settings))
    cues.extend(_suggest_energy_shift_cues(energy_summary, cues, settings))
    return sorted(cues, key=lambda cue: cue.time_seconds), []


def _suggest_intro_cue(energy_summary: EnergySummary, settings: AnalysisSettings) -> list[CueSuggestion]:
    if energy_summary.max_rms < INTRO_MIN_ABSOLUTE_RMS:
        return []

    envelope = energy_summary.normalized_envelope
    max_search_windows = min(len(envelope), int(INTRO_SEARCH_SECONDS / energy_summary.window_size_seconds))
    for index in range(max_search_windows):
        window_run = envelope[index : index + settings.sustained_window_count]
        if len(window_run) < settings.sustained_window_count:
            return []
        if all(value >= settings.silence_threshold for value in window_run):
            cue_time = round(index * energy_summary.window_size_seconds, 3)
            return [
                CueSuggestion(
                    label="intro",
                    time_seconds=cue_time,
                    confidence=settings.intro_confidence,
                    reason="Heuristic: first sustained non-silent RMS energy region; not beat- or phrase-aware.",
                    metadata={"heuristic": "first_sustained_energy"},
                )
            ]

    return []


def _suggest_outro_cue(
    energy_summary: EnergySummary,
    duration_seconds: float,
    settings: AnalysisSettings,
) -> list[CueSuggestion]:
    if duration_seconds < settings.minimum_outro_track_duration_seconds:
        return []
    if energy_summary.max_rms < OUTRO_MIN_ABSOLUTE_RMS:
        return []

    effective_window_seconds = _outro_effective_window_seconds(energy_summary, duration_seconds)
    search_start_seconds = _outro_search_start_seconds(duration_seconds, settings)
    search_start_index = max(
        0,
        math.floor(search_start_seconds / effective_window_seconds) - settings.sustained_window_count + 1,
    )
    if search_start_index >= len(energy_summary.normalized_envelope):
        return []

    final_run = _find_last_sustained_energy_run(
        energy_summary.normalized_envelope[search_start_index:],
        settings.silence_threshold,
        settings.sustained_window_count,
    )
    if final_run is None:
        return []

    run_start, run_end = (
        final_run[0] + search_start_index,
        final_run[1] + search_start_index,
    )
    run_length = run_end - run_start + 1
    if run_length < settings.sustained_window_count:
        return []

    lookback_windows = max(1, int(OUTRO_LOOKBACK_SECONDS / effective_window_seconds))
    cue_index = max(run_start, run_end - lookback_windows)
    cue_time = round(max(search_start_seconds, cue_index * effective_window_seconds), 3)
    if cue_time >= duration_seconds:
        return []

    return [
        CueSuggestion(
            label="outro",
            time_seconds=cue_time,
            confidence=settings.outro_confidence,
            reason="Heuristic: final sustained RMS energy region before fade or end; not beat- or phrase-aware.",
            metadata={"heuristic": "final_sustained_energy"},
        )
    ]


def _outro_search_start_seconds(duration_seconds: float, settings: AnalysisSettings) -> float:
    fraction_start = duration_seconds * (1 - settings.outro_search_last_fraction)
    seconds_start = duration_seconds - settings.outro_search_last_seconds
    return max(0.0, fraction_start, seconds_start)


def _outro_effective_window_seconds(energy_summary: EnergySummary, duration_seconds: float) -> float:
    envelope_length = len(energy_summary.normalized_envelope)
    if envelope_length == 0:
        return energy_summary.window_size_seconds

    envelope_duration = envelope_length * energy_summary.window_size_seconds
    if duration_seconds > envelope_duration + energy_summary.window_size_seconds:
        return duration_seconds / envelope_length
    return energy_summary.window_size_seconds


def _suggest_energy_shift_cues(
    energy_summary: EnergySummary,
    existing_cues: list[CueSuggestion],
    settings: AnalysisSettings,
) -> list[CueSuggestion]:
    if energy_summary.max_rms < INTRO_MIN_ABSOLUTE_RMS:
        return []

    envelope = energy_summary.normalized_envelope
    candidates: list[tuple[float, int, str]] = []
    for index in range(1, len(envelope)):
        signed_delta = envelope[index] - envelope[index - 1]
        delta = abs(signed_delta)
        if delta >= settings.energy_shift_min_delta and _has_sustained_windows_around_shift(
            envelope,
            index,
            settings.sustained_window_count,
        ):
            direction = "rise" if signed_delta > 0 else "drop"
            candidates.append((delta, index, direction))

    selected: list[CueSuggestion] = []
    blocked_times = [cue.time_seconds for cue in existing_cues]
    for delta, index, direction in sorted(candidates, reverse=True):
        cue_time = round(index * energy_summary.window_size_seconds, 3)
        if _is_too_close(cue_time, blocked_times, settings.energy_shift_min_spacing_seconds):
            continue
        if _is_too_close(cue_time, [cue.time_seconds for cue in selected], settings.energy_shift_min_spacing_seconds):
            continue
        selected.append(
            CueSuggestion(
                label="energy_shift",
                time_seconds=cue_time,
                confidence=settings.energy_shift_confidence,
                reason=f"Heuristic: notable RMS energy {direction}; not beat- or phrase-aware.",
                metadata={
                    "heuristic": "rms_energy_shift",
                    "direction": direction,
                    "delta": round(delta, 6),
                },
            )
        )
        if len(selected) >= settings.max_energy_shift_cues:
            break

    return sorted(selected, key=lambda cue: cue.time_seconds)


def _is_too_close(time_seconds: float, other_times: list[float], min_spacing_seconds: float) -> bool:
    return any(abs(time_seconds - other_time) <= min_spacing_seconds for other_time in other_times)


def _has_sustained_windows_around_shift(envelope: list[float], index: int, sustained_windows: int) -> bool:
    left = envelope[index - sustained_windows : index]
    right = envelope[index : index + sustained_windows]
    return len(left) == sustained_windows and len(right) == sustained_windows


def _find_last_sustained_energy_run(
    envelope: list[float],
    threshold: float,
    sustained_windows: int,
) -> tuple[int, int] | None:
    run_end: int | None = None
    run_length = 0
    for index in range(len(envelope) - 1, -1, -1):
        if envelope[index] >= threshold:
            if run_end is None:
                run_end = index
            run_length += 1
            continue

        if run_length >= sustained_windows and run_end is not None:
            return index + 1, run_end
        run_end = None
        run_length = 0

    if run_length >= sustained_windows and run_end is not None:
        return 0, run_end
    return None
