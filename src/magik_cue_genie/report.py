from __future__ import annotations

from html import escape
import json
from pathlib import Path
from typing import Any

from .analysis import AnalysisProfile, AnalysisSettings
from .feedback import feedback_rating_counts, find_matching_cue_feedback
from .models import AnalyzeResult, SCHEMA_VERSION, SkippedFile

TIMELINE_CUE_LABEL_CLASSES = {
    "intro": "cue-marker-intro",
    "outro": "cue-marker-outro",
    "energy_shift": "cue-marker-energy-shift",
}
TIMELINE_FALLBACK_CLASS_COUNT = 4
TIMELINE_MAX_BPM_TICKS = 80


def build_report_data(
    results: list[AnalyzeResult],
    skipped_files: list[SkippedFile],
    analysis_settings: AnalysisSettings | None = None,
    analysis_profile: str | AnalysisProfile = AnalysisProfile.BALANCED,
    references: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    analysis_settings = analysis_settings or AnalysisSettings()
    analysis_profile_name = AnalysisProfile(analysis_profile).value
    reference_lookup = references or {}
    analyzed_tracks = []
    for result in results:
        analysis = result.sidecar.analysis.to_report_dict()
        cues = [
            _cue_with_alignment_diagnostic(cue.to_dict(), analysis)
            for cue in result.sidecar.cues
        ]
        track = {
            "source_file": result.sidecar.source_file,
            "sidecar_file": result.sidecar_path.name,
            "analysis": analysis,
            "cues": cues,
            "warnings": result.sidecar.warnings,
        }
        reference = reference_lookup.get(Path(result.sidecar.source_file).name.lower())
        if reference is not None:
            track["reference"] = reference
        analyzed_tracks.append(track)

    skipped = [
        {
            "source_file": skipped_file.source_file,
            "reason": skipped_file.reason,
            **({"detail": skipped_file.detail} if skipped_file.detail else {}),
        }
        for skipped_file in skipped_files
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "analysis_profile": analysis_profile_name,
        "analysis_settings": analysis_settings.to_dict(),
        "analyzed_tracks": analyzed_tracks,
        "skipped_files": skipped,
        "summary": {
            "analyzed_count": len(analyzed_tracks),
            "skipped_count": len(skipped),
            "cue_count": sum(len(track["cues"]) for track in analyzed_tracks),
            "warning_count": sum(len(track["warnings"]) for track in analyzed_tracks),
            "bpm": _build_bpm_summary(analyzed_tracks),
        },
    }


def _build_bpm_summary(analyzed_tracks: list[dict[str, Any]]) -> dict[str, int]:
    summary = {
        "accepted_count": 0,
        "rejected_count": 0,
        "insufficient_onsets_count": 0,
        "missing_debug_count": 0,
        "estimated_count": 0,
    }
    for track in analyzed_tracks:
        analysis = track["analysis"]
        if analysis.get("estimated_bpm") is not None:
            summary["estimated_count"] += 1

        bpm_debug = analysis.get("bpm_debug")
        if not bpm_debug:
            summary["missing_debug_count"] += 1
            continue

        status = bpm_debug.get("status")
        if status == "accepted":
            summary["accepted_count"] += 1
        elif status == "rejected":
            summary["rejected_count"] += 1
        elif status == "insufficient_onsets":
            summary["insufficient_onsets_count"] += 1
    return summary


def _cue_with_alignment_diagnostic(cue: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    alignment = _build_cue_alignment_diagnostic(cue, analysis)
    return {
        **cue,
        "alignment_diagnostic": alignment,
        "suggested_improvement": _build_suggested_cue_improvement(cue, alignment),
    }


def _build_cue_alignment_diagnostic(cue: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    time_seconds = _optional_float(cue.get("time_seconds"))
    if time_seconds is None:
        return _unavailable_cue_alignment(None, reason="Cue time is unavailable.")

    grid = _best_alignment_grid(analysis)
    if grid is None:
        return _unavailable_cue_alignment(time_seconds, reason="No beat grid available.")

    bpm, source = grid
    beat_interval = 60 / bpm
    nearest_beat_index = round(time_seconds / beat_interval)
    snapped_time = nearest_beat_index * beat_interval
    offset = snapped_time - time_seconds
    offset_abs = abs(offset)
    if offset_abs <= 0.01:
        classification = "unchanged"
    elif offset_abs <= 0.05:
        classification = "near"
    else:
        classification = "shifted"

    return {
        "source": source,
        "bpm": round(bpm, 3),
        "original_time_seconds": round(time_seconds, 3),
        "original_timestamp": _format_timestamp(time_seconds),
        "candidate_time_seconds": round(max(0.0, snapped_time), 3),
        "candidate_timestamp": _format_timestamp(max(0.0, snapped_time)),
        "nearest_beat_number": nearest_beat_index + 1,
        "nearest_bar_number": (nearest_beat_index // 4) + 1,
        "offset_seconds": round(offset, 3),
        "classification": classification,
        "reason": "Report-only beat alignment diagnostic; cue was not moved.",
    }


def _unavailable_cue_alignment(time_seconds: float | None, reason: str) -> dict[str, Any]:
    return {
        "source": None,
        "bpm": None,
        "original_time_seconds": round(time_seconds, 3) if time_seconds is not None else None,
        "original_timestamp": _format_timestamp(time_seconds) if time_seconds is not None else None,
        "candidate_time_seconds": None,
        "candidate_timestamp": None,
        "nearest_beat_number": None,
        "nearest_bar_number": None,
        "offset_seconds": None,
        "classification": "unavailable",
        "reason": reason,
    }


def _build_suggested_cue_improvement(
    cue: dict[str, Any],
    alignment: dict[str, Any] | None,
) -> dict[str, Any]:
    current_time = _optional_float(cue.get("time_seconds"))
    suggested_time = _optional_float((alignment or {}).get("candidate_time_seconds"))
    if current_time is None or suggested_time is None:
        return {
            "current_time_seconds": round(current_time, 3) if current_time is not None else None,
            "current_timestamp": _format_timestamp(current_time) if current_time is not None else None,
            "suggested_time_seconds": None,
            "suggested_timestamp": None,
            "offset_seconds": None,
            "classification": "unavailable",
            "reason": "No beat-grid diagnostic was available; no suggestion made.",
        }

    offset = suggested_time - current_time
    offset_abs = abs(offset)
    if offset_abs <= 0.001:
        classification = "unchanged"
        reason = "Cue already aligns with the diagnostic beat grid; cue was not moved."
    elif offset_abs <= 0.075:
        classification = "near"
        reason = "Report-only suggestion from nearest beat-grid alignment; cue was not moved."
    else:
        classification = "shifted"
        reason = "Report-only suggestion from nearest beat-grid alignment; cue was not moved."

    return {
        "current_time_seconds": round(current_time, 3),
        "current_timestamp": _format_timestamp(current_time),
        "suggested_time_seconds": round(suggested_time, 3),
        "suggested_timestamp": _format_timestamp(suggested_time),
        "offset_seconds": round(offset, 3),
        "classification": classification,
        "reason": reason,
    }


def _best_alignment_grid(analysis: dict[str, Any]) -> tuple[float, str] | None:
    estimated_bpm = _optional_float(analysis.get("estimated_bpm"))
    if estimated_bpm is not None and estimated_bpm > 0:
        return estimated_bpm, "estimated_bpm"

    tempo_debug = analysis.get("tempo_candidates_debug") or {}
    top_candidate_bpm = _optional_float(tempo_debug.get("top_candidate_bpm"))
    if top_candidate_bpm is not None and top_candidate_bpm > 0:
        return top_candidate_bpm, "tempo_candidates_debug"

    return None


def render_report(report_data: dict[str, Any], previous_feedback: dict[str, dict[str, Any]] | None = None) -> str:
    rows = []
    report_summary = _render_report_summary(report_data)
    feedback_loaded = previous_feedback is not None
    previous_feedback_lookup = previous_feedback or {}
    reference_comparison_summary = _render_reference_comparison_summary(report_data, previous_feedback_lookup, feedback_loaded)
    for track in report_data["analyzed_tracks"]:
        analysis = track["analysis"]
        track_feedback = previous_feedback_lookup.get(Path(track["source_file"]).name.lower())
        duration = _format_timestamp(analysis["duration_seconds"]) if analysis["duration_seconds"] is not None else "Unknown"
        bpm = _format_bpm(analysis)
        estimated_key = analysis["estimated_key"] or "Unknown"
        energy_summary = _format_energy_summary(analysis["energy_summary"])
        energy_timeline = _render_energy_timeline(analysis, track["cues"])
        diagnostics = _render_track_diagnostics(track)
        bpm_debug = _render_bpm_debug(analysis.get("bpm_debug"))
        beat_debug = _render_beat_debug(analysis.get("beat_debug"))
        beat_visuals = _render_beat_visuals(analysis.get("beat_debug"), analysis.get("duration_seconds"))
        tempo_candidates_debug = _render_tempo_candidates_debug(analysis.get("tempo_candidates_debug"), track_feedback)
        reference = _render_reference(track)
        review_reference = _render_review_reference_controls(track)
        previous_review = _render_previous_review(track_feedback, feedback_loaded)
        reference_comparison = _render_reference_comparison(track, track_feedback)
        cue_alignment = _render_cue_alignment_diagnostics(track)
        suggested_improvements = _render_suggested_cue_improvements(track)
        track_warnings = _render_track_warnings(track["warnings"])
        cue_rows = _render_cues(track["source_file"], track["cues"], track_feedback)
        rows.append(
            f"""
            <section class="track-section" data-source-file="{escape(track["source_file"])}" data-sidecar-file="{escape(track["sidecar_file"])}">
              <h2>{escape(track["source_file"])}</h2>
              <dl class="track-details">
                <dt>Duration</dt><dd>{duration}</dd>
                <dt>Estimated BPM</dt><dd>{bpm}</dd>
                <dt>Estimated Key</dt><dd>{escape(str(estimated_key))}</dd>
                <dt>Energy</dt><dd>{energy_summary}</dd>
                <dt>Sidecar</dt><dd>{escape(track["sidecar_file"])}</dd>
              </dl>
              {diagnostics}
              {bpm_debug}
              {beat_debug}
              {beat_visuals}
              {tempo_candidates_debug}
              {reference}
              {review_reference}
              {previous_review}
              {reference_comparison}
              {energy_timeline}
              {cue_alignment}
              {suggested_improvements}
              {track_warnings}
              {cue_rows}
            </section>
            """
        )

    body = "\n".join(rows) if rows else "<p>No supported audio files were analyzed.</p>"
    skipped_block = _render_skipped_files(report_data["skipped_files"])

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Magik-cue-genie Report</title>
  <style>
    body {{
      color: #1f2933;
      font-family: Arial, sans-serif;
      line-height: 1.5;
      margin: 2rem auto;
      max-width: 960px;
      padding: 0 1rem;
    }}
    h1, h2 {{ color: #102a43; }}
    h3 {{ color: #243b53; margin-bottom: 0.25rem; }}
    section {{
      border-top: 1px solid #d9e2ec;
      padding: 1rem 0;
    }}
    dl {{
      display: grid;
      gap: 0.25rem 1rem;
      grid-template-columns: max-content 1fr;
    }}
    dt {{ font-weight: 700; }}
    .summary {{
      background: #f0f4f8;
      border: 1px solid #d9e2ec;
      padding: 1rem;
    }}
    .track-warning {{
      background: #fff8e6;
      border-left: 4px solid #f0b429;
      padding: 0.6rem 0.8rem;
    }}
    .diagnostics {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .diagnostics summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .diagnostics dl {{
      margin: 0.5rem 0 0;
    }}
    .bpm-debug {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .bpm-debug summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .bpm-debug dl {{
      margin: 0.5rem 0 0;
    }}
    .beat-debug {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .beat-debug summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .beat-debug dl {{
      margin: 0.5rem 0 0;
    }}
    .beat-visuals {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .beat-visuals summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .beat-visuals dl {{
      margin: 0.5rem 0;
    }}
    .beat-visuals svg {{
      background: #ffffff;
      border: 1px solid #d9e2ec;
      display: block;
      height: auto;
      max-width: 100%;
      width: 100%;
    }}
    .beat-visual-axis {{
      stroke: #9fb3c8;
      stroke-width: 1;
    }}
    .beat-visual-onset {{
      opacity: 0.45;
      stroke: #2563eb;
      stroke-width: 0.45;
    }}
    .beat-visual-peak {{
      opacity: 0.32;
      stroke: #d97706;
      stroke-width: 0.35;
    }}
    .beat-visual-grid {{
      opacity: 0.24;
      stroke: #334e68;
      stroke-width: 0.3;
    }}
    .beat-visual-empty {{
      color: #52606d;
      font-size: 0.9rem;
      margin: 0.4rem 0 0;
    }}
    .beat-visual-legend {{
      color: #334e68;
      display: flex;
      flex-wrap: wrap;
      font-size: 0.85rem;
      gap: 0.35rem 0.75rem;
      margin-top: 0.35rem;
    }}
    .tempo-candidates {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .tempo-candidates summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .tempo-candidates dl {{
      margin: 0.5rem 0;
    }}
    .tempo-candidates table {{
      font-size: 0.9rem;
      margin-top: 0.5rem;
    }}
    .cue-alignment {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .cue-alignment summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .cue-alignment table {{
      font-size: 0.9rem;
      margin-top: 0.5rem;
    }}
    .cue-alignment-note {{
      color: #52606d;
      font-size: 0.85rem;
    }}
    .suggested-improvements {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .suggested-improvements summary {{
      cursor: pointer;
      font-weight: 700;
    }}
    .suggested-improvements table {{
      font-size: 0.9rem;
      margin-top: 0.5rem;
    }}
    .suggested-improvements-note {{
      color: #52606d;
      font-size: 0.85rem;
    }}
    .reference {{
      background: #f8fafc;
      border-left: 4px solid #627d98;
      margin: 0.75rem 0;
      padding: 0.6rem 0.8rem;
    }}
    .reference dl {{
      margin: 0.35rem 0 0;
    }}
    .review-reference {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.75rem;
    }}
    .review-reference-grid {{
      display: grid;
      gap: 0.6rem;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    }}
    .review-reference label {{
      color: #334e68;
      display: grid;
      font-size: 0.9rem;
      font-weight: 700;
      gap: 0.25rem;
    }}
    .review-reference input,
    .review-reference textarea {{
      box-sizing: border-box;
      font: inherit;
      font-weight: 400;
      max-width: 100%;
      padding: 0.3rem;
      width: 100%;
    }}
    .review-reference textarea {{
      min-height: 4rem;
      resize: vertical;
    }}
    .previous-review {{
      background: #f0f4f8;
      border: 1px solid #d9e2ec;
      margin: 0.75rem 0;
      padding: 0.65rem 0.8rem;
    }}
    .previous-review p {{
      margin: 0.25rem 0;
    }}
    .previous-review-counts {{
      color: #334e68;
      font-size: 0.9rem;
    }}
    .previous-cue-feedback {{
      color: #334e68;
      font-size: 0.9rem;
    }}
    .previous-cue-feedback-empty {{
      color: #829ab1;
      font-size: 0.9rem;
    }}
    .reference-comparison {{
      background: #f8fafc;
      border-left: 4px solid #334e68;
      margin: 0.75rem 0;
      padding: 0.65rem 0.8rem;
    }}
    .reference-comparison dl {{
      margin: 0.35rem 0 0;
    }}
    .timeline {{
      margin: 1rem 0;
    }}
    .timeline svg {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      display: block;
      height: auto;
      max-width: 100%;
      width: 100%;
    }}
    .timeline-axis {{
      stroke: #9fb3c8;
      stroke-width: 1;
    }}
    .timeline-time-label {{
      fill: #52606d;
      font-size: 3px;
    }}
    .timeline-bar {{
      fill: #486581;
      opacity: 0.75;
    }}
    .timeline-marker {{
      opacity: 0.88;
      stroke-width: 0.55;
    }}
    .timeline-marker-cap {{
      opacity: 0.95;
    }}
    .cue-marker-intro {{
      fill: #2563eb;
      stroke: #2563eb;
    }}
    .cue-marker-outro {{
      fill: #059669;
      stroke: #059669;
    }}
    .cue-marker-energy-shift {{
      fill: #d97706;
      stroke: #d97706;
    }}
    .cue-marker-fallback-0 {{
      fill: #7c3aed;
      stroke: #7c3aed;
    }}
    .cue-marker-fallback-1 {{
      fill: #db2777;
      stroke: #db2777;
    }}
    .cue-marker-fallback-2 {{
      fill: #0891b2;
      stroke: #0891b2;
    }}
    .cue-marker-fallback-3 {{
      fill: #4d7c0f;
      stroke: #4d7c0f;
    }}
    .timeline-bpm-tick {{
      opacity: 0.28;
      stroke: #627d98;
      stroke-width: 0.25;
    }}
    .timeline-bpm-label {{
      color: #627d98;
      font-size: 0.8rem;
      margin-top: 0.2rem;
    }}
    .timeline-legend {{
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 0.75rem;
      margin-top: 0.35rem;
    }}
    .timeline-legend-item {{
      align-items: center;
      color: #334e68;
      display: inline-flex;
      font-size: 0.85rem;
      gap: 0.3rem;
    }}
    .timeline-legend-swatch {{
      display: inline-block;
      height: 0.75rem;
      width: 0.2rem;
    }}
    .timeline-legend-swatch.cue-marker-intro {{
      background: #2563eb;
    }}
    .timeline-legend-swatch.cue-marker-outro {{
      background: #059669;
    }}
    .timeline-legend-swatch.cue-marker-energy-shift {{
      background: #d97706;
    }}
    .timeline-legend-swatch.cue-marker-fallback-0 {{
      background: #7c3aed;
    }}
    .timeline-legend-swatch.cue-marker-fallback-1 {{
      background: #db2777;
    }}
    .timeline-legend-swatch.cue-marker-fallback-2 {{
      background: #0891b2;
    }}
    .timeline-legend-swatch.cue-marker-fallback-3 {{
      background: #4d7c0f;
    }}
    .timeline-empty {{
      color: #52606d;
      font-size: 0.95rem;
    }}
    .metadata {{
      color: #52606d;
      font-size: 0.9rem;
      word-break: break-word;
    }}
    .review-control {{
      display: grid;
      gap: 0.35rem;
      min-width: 12rem;
    }}
    .review-control input,
    .review-control select {{
      box-sizing: border-box;
      font: inherit;
      max-width: 100%;
      padding: 0.25rem;
      width: 100%;
    }}
    .no-cue-review {{
      background: #f8fafc;
      border: 1px solid #d9e2ec;
      margin-top: 1rem;
      padding: 0.75rem;
    }}
    .download-button {{
      background: #102a43;
      border: 0;
      color: white;
      cursor: pointer;
      font: inherit;
      padding: 0.55rem 0.8rem;
    }}
    .report-controls {{
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin: 1rem 0;
    }}
    .details-button {{
      background: #ffffff;
      border: 1px solid #9fb3c8;
      color: #243b53;
      cursor: pointer;
      font: inherit;
      padding: 0.5rem 0.75rem;
    }}
    table {{
      border-collapse: collapse;
      margin-top: 1rem;
      width: 100%;
    }}
    th, td {{
      border: 1px solid #d9e2ec;
      padding: 0.4rem 0.5rem;
      text-align: left;
    }}
  </style>
</head>
<body>
  <h1>Magik-cue-genie Report</h1>
  <p>Review-only placeholder output. No DJ software databases or source audio files were modified.</p>
  {report_summary}
  {reference_comparison_summary}
  <div class="report-controls">
    <button class="download-button" type="button" id="download-review-feedback">Download review feedback</button>
    <button class="details-button" type="button" id="expand-all-details">Expand all</button>
    <button class="details-button" type="button" id="collapse-all-details">Collapse all</button>
  </div>
  <h2>Tracks</h2>
  {body}
  {skipped_block}
  {_render_details_toggle_script()}
  {_render_review_export_script(report_data)}
</body>
</html>
"""


def _render_report_summary(report_data: dict[str, Any]) -> str:
    summary = report_data["summary"]
    bpm_summary = summary["bpm"]
    return f"""
    <section class="summary">
      <h2>Run Summary</h2>
      <dl>
        <dt>Analysis profile</dt><dd>{escape(report_data["analysis_profile"])}</dd>
        <dt>Analyzed tracks</dt><dd>{summary["analyzed_count"]}</dd>
        <dt>Skipped files</dt><dd>{summary["skipped_count"]}</dd>
        <dt>Cues</dt><dd>{summary["cue_count"]}</dd>
        <dt>Track warnings</dt><dd>{summary["warning_count"]}</dd>
        <dt>Estimated BPMs</dt><dd>{bpm_summary["estimated_count"]}</dd>
        <dt>BPM debug</dt><dd>accepted {bpm_summary["accepted_count"]}, rejected {bpm_summary["rejected_count"]}, insufficient {bpm_summary["insufficient_onsets_count"]}, missing {bpm_summary["missing_debug_count"]}</dd>
      </dl>
    </section>
    """


def _render_reference_comparison_summary(
    report_data: dict[str, Any],
    previous_feedback: dict[str, dict[str, Any]],
    feedback_loaded: bool,
) -> str:
    if not feedback_loaded:
        return ""

    summary = {
        "reference_bpm_count": 0,
        "estimated_bpm_count": 0,
        "near_match_count": 0,
        "half_double_match_count": 0,
        "miss_unknown_count": 0,
    }
    for track in report_data["analyzed_tracks"]:
        track_feedback = previous_feedback.get(Path(track["source_file"]).name.lower())
        if not track_feedback:
            continue

        estimated_bpm = _optional_float(track["analysis"].get("estimated_bpm"))
        reference_bpm = _optional_float(track_feedback.get("reference_bpm"))
        if estimated_bpm is not None:
            summary["estimated_bpm_count"] += 1
        if reference_bpm is None:
            continue

        summary["reference_bpm_count"] += 1
        relation = _bpm_reference_relation(estimated_bpm, reference_bpm)
        if relation == "near":
            summary["near_match_count"] += 1
        elif relation in {"half-time", "double-time"}:
            summary["half_double_match_count"] += 1
        else:
            summary["miss_unknown_count"] += 1

    return f"""
    <section class="summary">
      <h2>Reference BPM Comparison</h2>
      <dl>
        <dt>Tracks with reference BPM</dt><dd>{summary["reference_bpm_count"]}</dd>
        <dt>Tracks with estimated BPM</dt><dd>{summary["estimated_bpm_count"]}</dd>
        <dt>Exact/near BPM matches</dt><dd>{summary["near_match_count"]}</dd>
        <dt>Possible half/double-time matches</dt><dd>{summary["half_double_match_count"]}</dd>
        <dt>BPM misses/unknowns</dt><dd>{summary["miss_unknown_count"]}</dd>
      </dl>
    </section>
    """


def write_report(
    results: list[AnalyzeResult],
    skipped_files: list[SkippedFile],
    output_dir: Path,
    analysis_settings: AnalysisSettings | None = None,
    analysis_profile: str | AnalysisProfile = AnalysisProfile.BALANCED,
    references: dict[str, dict[str, Any]] | None = None,
    previous_feedback: dict[str, dict[str, Any]] | None = None,
) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    report_data = build_report_data(
        results,
        skipped_files,
        analysis_settings=analysis_settings,
        analysis_profile=analysis_profile,
        references=references,
    )
    html_path = output_dir / "report.html"
    json_path = output_dir / "report.json"
    html_path.write_text(render_report(report_data, previous_feedback=previous_feedback), encoding="utf-8")
    json_path.write_text(json.dumps(report_data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return html_path, json_path


def _render_cues(
    source_file: str,
    cues: list[dict[str, Any]],
    track_feedback: dict[str, Any] | None = None,
) -> str:
    if not cues:
        return (
            "<p>No cue suggestions yet.</p>"
            f'<div class="no-cue-review review-row" data-source-file="{escape(source_file)}" '
            'data-cue-label="" data-cue-time-seconds="" data-cue-timestamp="" data-confidence="" '
            'data-reason="" data-metadata="">'
            "<h3>No-Cue Review</h3>"
            "<p>Use this row to note missing cues or track-level cue feedback.</p>"
            f"{_render_review_controls()}"
            "</div>"
        )

    rows = []
    include_previous_feedback = track_feedback is not None
    for cue in sorted(cues, key=lambda item: item["time_seconds"]):
        metadata_text = _format_metadata(cue.get("metadata"))
        metadata_json = json.dumps(cue.get("metadata") or {}, sort_keys=True)
        cue_timestamp = _format_timestamp(cue["time_seconds"])
        alignment_note = _render_cue_alignment_table_note(cue.get("alignment_diagnostic"))
        previous_feedback = find_matching_cue_feedback(cue, track_feedback) if track_feedback else None
        previous_feedback_cell = f"<td>{_render_previous_cue_feedback(previous_feedback)}</td>" if include_previous_feedback else ""
        rows.append(
            f'<tr class="review-row" data-source-file="{escape(source_file)}" '
            f'data-cue-label="{escape(cue["label"])}" '
            f'data-cue-time-seconds="{escape(str(cue["time_seconds"]))}" '
            f'data-cue-timestamp="{cue_timestamp}" '
            f'data-confidence="{escape(str(cue["confidence"]))}" '
            f'data-reason="{escape(cue["reason"])}" '
            f'data-metadata="{escape(metadata_json)}">'
            f"<td>{escape(cue['label'])}</td>"
            f"<td>{cue_timestamp}</td>"
            f"<td>{cue['confidence']:.2f}</td>"
            f"<td>{escape(cue['reason'])}</td>"
            f"<td class=\"metadata\">{metadata_text}</td>"
            f"<td>{alignment_note}</td>"
            f"{previous_feedback_cell}"
            f"<td>{_render_review_controls()}</td>"
            "</tr>"
        )
    previous_header = "<th>Previous Review</th>" if include_previous_feedback else ""
    return (
        "<table>"
        f"<thead><tr><th>Label</th><th>Timestamp</th><th>Confidence</th><th>Reason</th><th>Metadata</th><th>Alignment</th>{previous_header}<th>Review</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )


def _render_review_controls() -> str:
    return (
        '<div class="review-control">'
        '<select class="review-rating" aria-label="Cue review rating">'
        '<option value=""></option>'
        '<option value="good">good</option>'
        '<option value="early">early</option>'
        '<option value="late">late</option>'
        '<option value="wrong">wrong</option>'
        '<option value="maybe">maybe</option>'
        "</select>"
        '<input class="review-note" type="text" aria-label="Cue review note" placeholder="Note" />'
        "</div>"
    )


def _render_cue_alignment_diagnostics(track: dict[str, Any]) -> str:
    cues = track.get("cues") or []
    if not cues:
        return ""

    rows = []
    for cue in sorted(cues, key=lambda item: item["time_seconds"]):
        alignment = cue.get("alignment_diagnostic") or {}
        rows.append(
            "<tr>"
            f"<td>{escape(str(cue.get('label', '')))}</td>"
            f"<td>{escape(str(alignment.get('original_timestamp') or _format_timestamp(cue.get('time_seconds', 0.0))))}</td>"
            f"<td>{escape(str(alignment.get('candidate_timestamp') or 'Unavailable'))}</td>"
            f"<td>{escape(str(alignment.get('nearest_beat_number') or 'Unavailable'))}</td>"
            f"<td>{escape(str(alignment.get('nearest_bar_number') or 'Unavailable'))}</td>"
            f"<td>{escape(_format_alignment_offset(alignment.get('offset_seconds')))}</td>"
            f"<td>{escape(str(alignment.get('classification') or 'unavailable'))}</td>"
            f"<td>{escape(str(alignment.get('reason') or ''))}</td>"
            "</tr>"
        )
    return f"""
    <details class="cue-alignment">
      <summary>Cue Alignment Diagnostics</summary>
      <p class="cue-alignment-note">Report-only beat-snap suggestions. Cue timestamps in sidecars were not changed.</p>
      <table>
        <thead><tr><th>Label</th><th>Original</th><th>Candidate snap</th><th>Beat</th><th>4-beat group</th><th>Offset</th><th>Class</th><th>Reason</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
    </details>
    """


def _render_cue_alignment_table_note(alignment: dict[str, Any] | None) -> str:
    if not alignment:
        return '<span class="cue-alignment-note">Unavailable</span>'
    if alignment.get("classification") == "unavailable":
        return f'<span class="cue-alignment-note">{escape(str(alignment.get("reason") or "No beat grid available."))}</span>'

    candidate_timestamp = alignment.get("candidate_timestamp") or "Unavailable"
    offset = _format_alignment_offset(alignment.get("offset_seconds"))
    classification = alignment.get("classification") or "unavailable"
    return (
        '<span class="cue-alignment-note">'
        f"{escape(str(candidate_timestamp))} ({escape(classification)}, {escape(offset)})"
        "</span>"
    )


def _render_suggested_cue_improvements(track: dict[str, Any]) -> str:
    cues = track.get("cues") or []
    if not cues:
        return ""

    rows = []
    for cue in sorted(cues, key=lambda item: item["time_seconds"]):
        suggestion = cue.get("suggested_improvement") or {}
        rows.append(
            "<tr>"
            f"<td>{escape(str(cue.get('label', '')))}</td>"
            f"<td>{escape(str(suggestion.get('current_timestamp') or _format_timestamp(cue.get('time_seconds', 0.0))))}</td>"
            f"<td>{escape(str(suggestion.get('suggested_timestamp') or 'Unavailable'))}</td>"
            f"<td>{escape(_format_alignment_offset(suggestion.get('offset_seconds')))}</td>"
            f"<td>{escape(str(suggestion.get('classification') or 'unavailable'))}</td>"
            f"<td>{escape(str(suggestion.get('reason') or ''))}</td>"
            "</tr>"
        )
    return f"""
    <details class="suggested-improvements">
      <summary>Suggested Cue Improvements</summary>
      <p class="suggested-improvements-note">These are report-only suggestions. Sidecar cue timestamps were not changed.</p>
      <table>
        <thead><tr><th>Label</th><th>Current time</th><th>Suggested time</th><th>Offset</th><th>Class</th><th>Reason</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
    </details>
    """


def _format_alignment_offset(offset_seconds: Any) -> str:
    offset = _optional_float(offset_seconds)
    if offset is None:
        return "Unavailable"
    return f"{offset:+.3f}s"


def _render_details_toggle_script() -> str:
    return """
  <script>
    (function () {
      function setAllDetailsOpen(isOpen) {
        document.querySelectorAll("details").forEach(function (details) {
          details.open = isOpen;
        });
      }

      document.getElementById("expand-all-details").addEventListener("click", function () {
        setAllDetailsOpen(true);
      });
      document.getElementById("collapse-all-details").addEventListener("click", function () {
        setAllDetailsOpen(false);
      });
    })();
  </script>
    """


def _render_review_export_script(report_data: dict[str, Any]) -> str:
    report_metadata = {
        "schema_version": report_data["schema_version"],
        "analysis_profile": report_data["analysis_profile"],
    }
    return f"""
  <script>
    (function () {{
      const reportMetadata = {json.dumps(report_metadata, sort_keys=True)};

      function controlValue(section, selector) {{
        const control = section.querySelector(selector);
        return control ? control.value : "";
      }}

      function collectCueFeedback(section) {{
        return Array.from(section.querySelectorAll(".review-row")).map(function (row) {{
          const rating = row.querySelector(".review-rating");
          const note = row.querySelector(".review-note");
          return {{
            cue_label: row.dataset.cueLabel || "",
            cue_time_seconds: row.dataset.cueTimeSeconds || "",
            cue_timestamp: row.dataset.cueTimestamp || "",
            detected_confidence: row.dataset.confidence || "",
            review_rating: rating ? rating.value : "",
            review_note: note ? note.value : ""
          }};
        }});
      }}

      function collectFeedback() {{
        return {{
          metadata: {{
            ...reportMetadata,
            generated_at: new Date().toISOString()
          }},
          tracks: Array.from(document.querySelectorAll(".track-section")).map(function (section) {{
            return {{
              source_file: section.dataset.sourceFile || "",
              reference_bpm: controlValue(section, ".track-reference-bpm"),
              reference_key: controlValue(section, ".track-reference-key"),
              reference_source: controlValue(section, ".track-reference-source"),
              reviewer_notes: controlValue(section, ".track-reviewer-notes"),
              cue_feedback: collectCueFeedback(section)
            }};
          }})
        }};
      }}

      function downloadReviewFeedback() {{
        const feedback = collectFeedback();
        const json = JSON.stringify(feedback, null, 2) + "\\n";
        const blob = new Blob([json], {{ type: "application/json;charset=utf-8" }});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "magik-cue-genie-review-feedback.json";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }}

      const button = document.getElementById("download-review-feedback");
      if (button) {{
        button.addEventListener("click", downloadReviewFeedback);
      }}
    }}());
  </script>
    """


def _render_energy_timeline(analysis: dict[str, Any], cues: list[dict[str, Any]]) -> str:
    energy_summary = analysis.get("energy_summary")
    if not energy_summary:
        return '<div class="timeline timeline-empty">No energy timeline available.</div>'

    envelope = energy_summary.get("normalized_envelope") or []
    if not envelope:
        return '<div class="timeline timeline-empty">Energy timeline unavailable: empty envelope.</div>'

    duration_seconds = analysis.get("duration_seconds")
    window_size_seconds = energy_summary.get("window_size_seconds") or 0
    duration = _timeline_duration_seconds(duration_seconds, len(envelope), window_size_seconds)
    bars = _render_timeline_bars(envelope)
    bpm_ticks = _render_bpm_ticks(analysis, duration)
    markers = _render_timeline_markers(cues, duration)
    legend = _render_timeline_legend(cues)
    bpm_label = _render_bpm_grid_label(analysis, bpm_ticks)
    end_label = _format_timestamp(duration)
    return f"""
    <div class="timeline" aria-label="Normalized RMS energy timeline">
      <svg viewBox="0 0 100 42" role="img" aria-label="Normalized RMS energy timeline with cue markers">
        <line class="timeline-axis" x1="0" y1="34" x2="100" y2="34" />
        {bars}
        {bpm_ticks}
        {markers}
        <text class="timeline-time-label" x="0" y="40">0:00.000</text>
        <text class="timeline-time-label" x="100" y="40" text-anchor="end">{end_label}</text>
      </svg>
      {bpm_label}
      {legend}
    </div>
    """


def _render_timeline_bars(envelope: list[float]) -> str:
    if not envelope:
        return ""

    bar_width = 100 / len(envelope)
    bars = []
    for index, value in enumerate(envelope):
        bounded_value = max(0.0, min(1.0, float(value)))
        height = bounded_value * 28
        x = index * bar_width
        y = 34 - height
        bars.append(
            f'<rect class="timeline-bar" x="{x:.3f}" y="{y:.3f}" '
            f'width="{bar_width:.3f}" height="{height:.3f}" />'
        )
    return "".join(bars)


def _render_timeline_markers(cues: list[dict[str, Any]], duration_seconds: float) -> str:
    markers = []
    for cue in cues:
        position = _cue_marker_position_percent(cue.get("time_seconds", 0.0), duration_seconds)
        label_text = str(cue.get("label", "cue"))
        timestamp = _format_timestamp(float(cue.get("time_seconds", 0.0)))
        marker_class = _timeline_cue_marker_class(label_text)
        title = _format_cue_marker_title(cue, timestamp)
        markers.append(
            f'<g class="timeline-cue-marker {marker_class}">'
            f"<title>{title}</title>"
            f'<line class="timeline-marker {marker_class}" x1="{position:.3f}" y1="3" x2="{position:.3f}" y2="35" />'
            f'<circle class="timeline-marker-cap {marker_class}" cx="{position:.3f}" cy="3" r="0.9" />'
            "</g>"
        )
    return "".join(markers)


def _render_timeline_legend(cues: list[dict[str, Any]]) -> str:
    if not cues:
        return '<div class="timeline-legend timeline-empty">No cue markers.</div>'

    items = []
    for cue in sorted(cues, key=lambda item: item["time_seconds"]):
        label_text = str(cue.get("label", "cue"))
        label = escape(label_text)
        timestamp = _format_timestamp(float(cue.get("time_seconds", 0.0)))
        swatch_class = f"timeline-legend-swatch {_timeline_cue_marker_class(label_text)}"
        items.append(
            f'<span class="timeline-legend-item">'
            f'<span class="{swatch_class}" aria-hidden="true"></span>'
            f"{label} {timestamp}"
            "</span>"
        )
    return f'<div class="timeline-legend" aria-label="Cue marker legend">{"".join(items)}</div>'


def _render_bpm_ticks(analysis: dict[str, Any], duration_seconds: float) -> str:
    estimated_bpm = analysis.get("estimated_bpm")
    if estimated_bpm is None or duration_seconds <= 0:
        return ""

    bpm = float(estimated_bpm)
    if bpm <= 0:
        return ""

    tick_interval_seconds = (60 / bpm) * 4
    if tick_interval_seconds <= 0:
        return ""

    tick_count = int(duration_seconds // tick_interval_seconds) + 1
    stride = max(1, (tick_count + TIMELINE_MAX_BPM_TICKS - 1) // TIMELINE_MAX_BPM_TICKS)
    ticks = []
    for tick_index in range(0, tick_count, stride):
        tick_time = tick_index * tick_interval_seconds
        if tick_time > duration_seconds:
            continue
        position = _cue_marker_position_percent(tick_time, duration_seconds)
        ticks.append(f'<line class="timeline-bpm-tick" x1="{position:.3f}" y1="31" x2="{position:.3f}" y2="35" />')
    return "".join(ticks)


def _render_bpm_grid_label(analysis: dict[str, Any], bpm_ticks: str) -> str:
    estimated_bpm = analysis.get("estimated_bpm")
    if estimated_bpm is None or not bpm_ticks:
        return ""
    return f'<div class="timeline-bpm-label">BPM grid: {escape(str(estimated_bpm))}, 4-beat ticks</div>'


def _timeline_cue_marker_class(label: str) -> str:
    known_class = TIMELINE_CUE_LABEL_CLASSES.get(label)
    if known_class:
        return known_class
    fallback_index = sum(ord(character) for character in label) % TIMELINE_FALLBACK_CLASS_COUNT
    return f"cue-marker-fallback-{fallback_index}"


def _format_cue_marker_title(cue: dict[str, Any], timestamp: str) -> str:
    metadata_summary = _format_metadata_text(cue.get("metadata")) or "None"
    return escape(
        "\n".join(
            [
                f"Label: {cue.get('label', 'cue')}",
                f"Timestamp: {timestamp}",
                f"Confidence: {cue.get('confidence', '')}",
                f"Reason: {cue.get('reason', '')}",
                f"Metadata: {metadata_summary}",
            ]
        )
    )


def _format_metadata_text(metadata: dict[str, Any] | None) -> str:
    if not metadata:
        return ""
    return ", ".join(f"{key}: {value}" for key, value in metadata.items())


def _cue_marker_position_percent(time_seconds: float, duration_seconds: float) -> float:
    if duration_seconds <= 0:
        return 0.0
    return max(0.0, min(100.0, (time_seconds / duration_seconds) * 100))


def _timeline_duration_seconds(
    duration_seconds: float | None,
    envelope_length: int,
    window_size_seconds: float,
) -> float:
    if duration_seconds is not None and duration_seconds > 0:
        return duration_seconds
    return max(0.0, envelope_length * window_size_seconds)


def _render_track_warnings(warnings: list[str]) -> str:
    if not warnings:
        return ""
    items = "".join(f"<li>{escape(warning)}</li>" for warning in warnings)
    return f"<div class=\"track-warning\"><h3>Track Warnings</h3><ul>{items}</ul></div>"


def _render_previous_review(track_feedback: dict[str, Any] | None, feedback_loaded: bool) -> str:
    if track_feedback is None:
        if not feedback_loaded:
            return ""
        return (
            '<div class="previous-review">'
            "<h3>Previous review</h3>"
            '<p class="previous-review-counts">No previous feedback loaded for this track.</p>'
            "</div>"
        )

    counts = feedback_rating_counts(track_feedback)
    count_text = ", ".join(f"{rating} {counts[rating]}" for rating in ("good", "early", "late", "wrong", "maybe", "blank"))
    return f"""
    <div class="previous-review">
      <h3>Previous review</h3>
      <p class="previous-review-counts">Rating counts: {escape(count_text)}</p>
    </div>
    """


def _render_previous_cue_feedback(cue_feedback: dict[str, Any] | None) -> str:
    if cue_feedback is None:
        return '<span class="previous-cue-feedback-empty">No match</span>'

    rating = str(cue_feedback.get("review_rating") or "blank").strip() or "blank"
    note = str(cue_feedback.get("review_note") or "").strip()
    note_text = f" - {note}" if note else ""
    return f'<span class="previous-cue-feedback">{escape(rating)}{escape(note_text)}</span>'


def _render_reference_comparison(track: dict[str, Any], track_feedback: dict[str, Any] | None) -> str:
    if not track_feedback:
        return ""

    analysis = track["analysis"]
    estimated_bpm = _optional_float(analysis.get("estimated_bpm"))
    reference_bpm = _optional_float(track_feedback.get("reference_bpm"))
    relation = _format_bpm_reference_relation(estimated_bpm, reference_bpm)
    bpm_difference = _format_bpm_difference(estimated_bpm, reference_bpm)
    reference_key = str(track_feedback.get("reference_key") or "Unknown")
    reference_source = str(track_feedback.get("reference_source") or "")
    source_row = f"<dt>Reference source</dt><dd>{escape(reference_source)}</dd>" if reference_source else ""
    return f"""
    <div class="reference-comparison">
      <h3>Reference comparison</h3>
      <dl>
        <dt>Estimated BPM</dt><dd>{_format_optional(estimated_bpm)}</dd>
        <dt>Reference BPM</dt><dd>{_format_optional(reference_bpm)}</dd>
        <dt>BPM difference</dt><dd>{bpm_difference}</dd>
        <dt>Half/double-time diagnostic</dt><dd>{escape(relation)}</dd>
        <dt>Estimated Key</dt><dd>{escape(str(analysis.get("estimated_key") or "Unknown"))}</dd>
        <dt>Reference Key</dt><dd>{escape(reference_key)}</dd>
        {source_row}
      </dl>
    </div>
    """


def _format_bpm_difference(estimated_bpm: float | None, reference_bpm: float | None) -> str:
    if estimated_bpm is None or reference_bpm is None:
        return "Unknown"
    return f"{abs(estimated_bpm - reference_bpm):.2f}"


def _format_bpm_reference_relation(estimated_bpm: float | None, reference_bpm: float | None) -> str:
    relation = _bpm_reference_relation(estimated_bpm, reference_bpm)
    if relation == "near":
        return "near match"
    if relation == "half-time":
        return "possible half-time match"
    if relation == "double-time":
        return "possible double-time match"
    if relation == "unknown":
        return "unknown"
    return "miss"


def _bpm_reference_relation(estimated_bpm: float | None, reference_bpm: float | None) -> str:
    if estimated_bpm is None or reference_bpm is None or reference_bpm <= 0:
        return "unknown"

    tolerance = 1.0
    if abs(estimated_bpm - reference_bpm) <= tolerance:
        return "near"
    if abs(estimated_bpm - (reference_bpm / 2)) <= tolerance:
        return "half-time"
    if abs(estimated_bpm - (reference_bpm * 2)) <= tolerance:
        return "double-time"
    return "miss"


def _render_review_reference_controls(track: dict[str, Any]) -> str:
    reference = track.get("reference") or {}
    reference_bpm = "" if reference.get("bpm") is None else str(reference.get("bpm"))
    reference_key = "" if reference.get("key") is None else str(reference.get("key"))
    reviewer_notes = "" if reference.get("notes") is None else str(reference.get("notes"))
    return f"""
    <div class="review-reference">
      <h3>Review / Reference</h3>
      <div class="review-reference-grid">
        <label>
          Reference BPM
          <input class="track-reference-bpm" type="number" step="0.01" value="{escape(reference_bpm)}" />
        </label>
        <label>
          Reference Key
          <input class="track-reference-key" type="text" value="{escape(reference_key)}" />
        </label>
        <label>
          Reference source / URL
          <input class="track-reference-source" type="text" value="" />
        </label>
        <label>
          Reviewer notes
          <textarea class="track-reviewer-notes">{escape(reviewer_notes)}</textarea>
        </label>
      </div>
    </div>
    """


def _render_reference(track: dict[str, Any]) -> str:
    reference = track.get("reference")
    if not reference:
        return ""

    analysis = track["analysis"]
    reference_bpm = reference.get("bpm")
    bpm_delta = _format_bpm_delta(analysis.get("estimated_bpm"), reference_bpm)
    return f"""
    <div class="reference">
      <h3>Reference</h3>
      <dl>
        <dt>Reference BPM</dt><dd>{_format_optional(reference_bpm)}</dd>
        <dt>Reference Key</dt><dd>{escape(str(reference.get("key") or "Unknown"))}</dd>
        <dt>Notes</dt><dd>{escape(str(reference.get("notes") or ""))}</dd>
        {bpm_delta}
      </dl>
    </div>
    """


def _format_bpm_delta(estimated_bpm: float | None, reference_bpm: float | None) -> str:
    if estimated_bpm is None or reference_bpm is None:
        return ""
    delta = float(estimated_bpm) - float(reference_bpm)
    return f"<dt>BPM delta</dt><dd>{delta:+.2f}</dd>"


def _render_skipped_files(skipped_files: list[dict[str, Any]]) -> str:
    if not skipped_files:
        return ""

    rows = []
    for skipped_file in skipped_files:
        detail = skipped_file.get("detail", "")
        rows.append(
            "<tr>"
            f"<td>{escape(skipped_file['source_file'])}</td>"
            f"<td>{escape(skipped_file['reason'])}</td>"
            f"<td>{escape(detail)}</td>"
            "</tr>"
        )
    return (
        "<h2>Skipped files</h2>"
        "<table>"
        "<thead><tr><th>File</th><th>Reason</th><th>Detail</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody>"
        "</table>"
    )


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


def _format_optional(value: float | None) -> str:
    return "Unknown" if value is None else str(value)


def _format_energy_summary(energy_summary: dict[str, Any] | None) -> str:
    if energy_summary is None:
        return "Unknown"
    return f"max RMS {energy_summary['max_rms']}, mean RMS {energy_summary['mean_rms']}"


def _render_track_diagnostics(track: dict[str, Any]) -> str:
    analysis = track["analysis"]
    bpm_debug = analysis.get("bpm_debug")
    cue_labels = [str(cue.get("label", "")) for cue in track["cues"]]
    cue_label_text = ", ".join(label for label in cue_labels if label) or "None"
    bpm_details = _format_bpm(analysis)
    bpm_status = str(bpm_debug.get("status", "Unknown")) if bpm_debug else "Unknown"
    bpm_reason = str(bpm_debug.get("reason", "No BPM debug data available.")) if bpm_debug else "No BPM debug data available."
    return f"""
    <details class="diagnostics">
      <summary>Diagnostics</summary>
      <dl>
        <dt>Cue count</dt><dd>{len(track["cues"])}</dd>
        <dt>Warning count</dt><dd>{len(track["warnings"])}</dd>
        <dt>BPM estimate</dt><dd>{bpm_details}</dd>
        <dt>BPM debug status</dt><dd>{escape(bpm_status)}</dd>
        <dt>BPM debug reason</dt><dd>{escape(bpm_reason)}</dd>
        <dt>Cue labels</dt><dd>{escape(cue_label_text)}</dd>
      </dl>
    </details>
    """


def _render_bpm_debug(bpm_debug: dict[str, Any] | None) -> str:
    if not bpm_debug:
        return ""

    onset_count = len(bpm_debug.get("onset_times_seconds") or [])
    candidate_bpms = _format_debug_list(bpm_debug.get("candidate_bpms") or [])
    return f"""
    <details class="bpm-debug">
      <summary>BPM Debug</summary>
      <dl>
        <dt>Status</dt><dd>{escape(str(bpm_debug.get("status", "")))}</dd>
        <dt>Reason</dt><dd>{escape(str(bpm_debug.get("reason", "")))}</dd>
        <dt>Detected onsets</dt><dd>{onset_count}</dd>
        <dt>Selected BPM</dt><dd>{_format_optional(bpm_debug.get("selected_bpm"))}</dd>
        <dt>Confidence</dt><dd>{_format_optional(bpm_debug.get("confidence"))}</dd>
        <dt>Candidate BPMs</dt><dd>{candidate_bpms}</dd>
      </dl>
    </details>
    """


def _render_beat_debug(beat_debug: dict[str, Any] | None) -> str:
    if not beat_debug:
        return ""

    onset_count = len(beat_debug.get("onset_times_seconds") or [])
    peak_count = len(beat_debug.get("local_peak_times_seconds") or [])
    candidate_intervals = _format_debug_list(beat_debug.get("candidate_beat_intervals_seconds") or [])
    candidate_bpms = _format_debug_list(beat_debug.get("normalized_candidate_bpms") or [])
    return f"""
    <details class="beat-debug">
      <summary>Beat / Onset Diagnostics</summary>
      <dl>
        <dt>Status</dt><dd>{escape(str(beat_debug.get("status", "")))}</dd>
        <dt>Reason</dt><dd>{escape(str(beat_debug.get("reason", "")))}</dd>
        <dt>Detected onsets</dt><dd>{onset_count}</dd>
        <dt>Local energy peaks</dt><dd>{peak_count}</dd>
        <dt>Candidate beat intervals</dt><dd>{candidate_intervals}</dd>
        <dt>Normalized candidate BPMs</dt><dd>{candidate_bpms}</dd>
        <dt>Selected beat interval</dt><dd>{_format_optional(beat_debug.get("selected_beat_interval_seconds"))}</dd>
        <dt>Selected BPM</dt><dd>{_format_optional(beat_debug.get("selected_bpm"))}</dd>
        <dt>Confidence</dt><dd>{_format_optional(beat_debug.get("confidence"))}</dd>
      </dl>
    </details>
    """


def _render_beat_visuals(beat_debug: dict[str, Any] | None, duration_seconds: float | None) -> str:
    if not beat_debug:
        return ""

    onset_times = [_optional_float(value) for value in (beat_debug.get("onset_times_seconds") or [])]
    peak_times = [_optional_float(value) for value in (beat_debug.get("local_peak_times_seconds") or [])]
    onset_times = [value for value in onset_times if value is not None]
    peak_times = [value for value in peak_times if value is not None]
    duration = _beat_visual_duration(duration_seconds, onset_times, peak_times)
    selected_bpm = _optional_float(beat_debug.get("selected_bpm"))
    selected_interval = _optional_float(beat_debug.get("selected_beat_interval_seconds"))
    grid_ticks = _render_selected_beat_grid_ticks(selected_interval, duration) if selected_bpm is not None else ""
    onset_ticks = _render_beat_visual_ticks(onset_times, duration, "beat-visual-onset", 4, 24)
    peak_ticks = _render_beat_visual_ticks(peak_times, duration, "beat-visual-peak", 18, 32)
    visual = (
        f"""
        <svg viewBox="0 0 100 36" role="img" aria-label="Beat and onset diagnostic timeline">
          <line class="beat-visual-axis" x1="0" y1="30" x2="100" y2="30" />
          {grid_ticks}
          {peak_ticks}
          {onset_ticks}
        </svg>
        <div class="beat-visual-legend">
          <span>blue: onsets</span>
          <span>orange: local peaks</span>
          <span>gray: selected beat grid</span>
        </div>
        """
        if duration > 0 and (onset_ticks or peak_ticks or grid_ticks)
        else '<p class="beat-visual-empty">No beat/onset timing markers available.</p>'
    )
    return f"""
    <details class="beat-visuals">
      <summary>Beat Grid / Onset Visuals</summary>
      <dl>
        <dt>Detected onsets</dt><dd>{len(onset_times)}</dd>
        <dt>Local energy peaks</dt><dd>{len(peak_times)}</dd>
        <dt>Selected BPM</dt><dd>{_format_optional(selected_bpm)}</dd>
        <dt>Selected beat interval</dt><dd>{_format_optional(selected_interval)}</dd>
        <dt>Confidence</dt><dd>{_format_optional(beat_debug.get("confidence"))}</dd>
        <dt>Reason</dt><dd>{escape(str(beat_debug.get("reason", "")))}</dd>
      </dl>
      {visual}
    </details>
    """


def _render_tempo_candidates_debug(
    tempo_debug: dict[str, Any] | None,
    track_feedback: dict[str, Any] | None = None,
) -> str:
    if not tempo_debug:
        return ""

    candidates = tempo_debug.get("candidate_bpms") or []
    rows = "".join(
        "<tr>"
        f"<td>{escape(str(candidate.get('bpm', '')))}</td>"
        f"<td>{escape(str(candidate.get('score', '')))}</td>"
        f"<td>{escape(str(candidate.get('count', '')))}</td>"
        f"<td>{escape(str(candidate.get('onset_candidate_support_score', '')))}</td>"
        f"<td>{escape(str(candidate.get('interval_stability_score', '')))}</td>"
        f"<td>{escape(str(candidate.get('source', '')))}</td>"
        f"<td>{escape(str(candidate.get('notes', '')))}</td>"
        "</tr>"
        for candidate in candidates
    )
    table = (
        "<table>"
        "<thead><tr><th>BPM</th><th>Score</th><th>Count</th><th>Onset support</th><th>Stability</th><th>Source</th><th>Notes</th></tr></thead>"
        f"<tbody>{rows}</tbody>"
        "</table>"
        if rows
        else '<p class="beat-visual-empty">No tempo candidates available.</p>'
    )
    reference_comparison = _render_tempo_candidate_reference_comparison(tempo_debug, track_feedback)
    return f"""
    <details class="tempo-candidates">
      <summary>Tempo Candidate Diagnostics</summary>
      <dl>
        <dt>Status</dt><dd>{escape(str(tempo_debug.get("status", "")))}</dd>
        <dt>Reason</dt><dd>{escape(str(tempo_debug.get("reason", "")))}</dd>
        <dt>Top candidate BPM</dt><dd>{_format_optional(tempo_debug.get("top_candidate_bpm"))}</dd>
        <dt>Top candidate confidence</dt><dd>{_format_optional(tempo_debug.get("top_candidate_confidence"))}</dd>
        <dt>Accepted BPM agreement</dt><dd>{escape(str(tempo_debug.get("estimated_bpm_agreement", "")))}</dd>
      </dl>
      {table}
      {reference_comparison}
    </details>
    """


def _render_tempo_candidate_reference_comparison(
    tempo_debug: dict[str, Any],
    track_feedback: dict[str, Any] | None,
) -> str:
    if not track_feedback:
        return ""

    reference_bpm = _optional_float(track_feedback.get("reference_bpm"))
    if reference_bpm is None:
        return ""

    candidates = tempo_debug.get("candidate_bpms") or []
    numeric_candidates = [
        candidate
        for candidate in candidates
        if _optional_float(candidate.get("bpm")) is not None
    ]
    if not numeric_candidates:
        return """
        <div class="tempo-reference-comparison">
          <h4>Tempo candidate/reference comparison</h4>
          <p>No tempo candidates available for reference comparison.</p>
        </div>
        """

    closest_candidate = min(
        numeric_candidates,
        key=lambda candidate: abs((_optional_float(candidate.get("bpm")) or 0.0) - reference_bpm),
    )
    closest_bpm = _optional_float(closest_candidate.get("bpm"))
    top_bpm = _optional_float(tempo_debug.get("top_candidate_bpm"))
    closest_difference = abs((closest_bpm or 0.0) - reference_bpm)
    top_result = _tempo_reference_match_result(top_bpm, reference_bpm)
    return f"""
    <div class="tempo-reference-comparison">
      <h4>Tempo candidate/reference comparison</h4>
      <dl>
        <dt>Reference BPM</dt><dd>{_format_optional(reference_bpm)}</dd>
        <dt>Closest candidate to reference</dt><dd>{_format_optional(closest_bpm)}</dd>
        <dt>Candidate/reference BPM difference</dt><dd>{closest_difference:.2f}</dd>
        <dt>Top candidate reference result</dt><dd>{escape(top_result)}</dd>
      </dl>
    </div>
    """


def _tempo_reference_match_result(candidate_bpm: float | None, reference_bpm: float | None) -> str:
    if candidate_bpm is None or reference_bpm is None:
        return "unknown"
    difference = abs(candidate_bpm - reference_bpm)
    if difference <= 1.0:
        return "matches reference"
    if difference <= 2.0:
        return "near-matches reference"
    return "misses reference"


def _beat_visual_duration(
    duration_seconds: float | None,
    onset_times: list[float],
    peak_times: list[float],
) -> float:
    if duration_seconds is not None and duration_seconds > 0:
        return duration_seconds
    marker_times = [*onset_times, *peak_times]
    return max(marker_times, default=0.0)


def _render_beat_visual_ticks(
    times: list[float],
    duration_seconds: float,
    css_class: str,
    y1: int,
    y2: int,
) -> str:
    if duration_seconds <= 0:
        return ""

    ticks = []
    for time_seconds in times:
        position = _cue_marker_position_percent(time_seconds, duration_seconds)
        ticks.append(
            f'<line class="{css_class}" x1="{position:.3f}" y1="{y1}" x2="{position:.3f}" y2="{y2}">'
            f"<title>{time_seconds:.3f}s</title>"
            "</line>"
        )
    return "".join(ticks)


def _render_selected_beat_grid_ticks(selected_interval: float | None, duration_seconds: float) -> str:
    if selected_interval is None or selected_interval <= 0 or duration_seconds <= 0:
        return ""

    tick_count = int(duration_seconds // selected_interval) + 1
    stride = max(1, (tick_count + TIMELINE_MAX_BPM_TICKS - 1) // TIMELINE_MAX_BPM_TICKS)
    ticks = []
    for tick_index in range(0, tick_count, stride):
        tick_time = tick_index * selected_interval
        if tick_time > duration_seconds:
            continue
        position = _cue_marker_position_percent(tick_time, duration_seconds)
        ticks.append(f'<line class="beat-visual-grid" x1="{position:.3f}" y1="8" x2="{position:.3f}" y2="32" />')
    return "".join(ticks)


def _format_debug_list(values: list[Any]) -> str:
    if not values:
        return "None"
    return escape(", ".join(str(value) for value in values))


def _format_bpm(analysis: dict[str, Any]) -> str:
    if analysis["estimated_bpm"] is None:
        return "Unknown"

    parts = [str(analysis["estimated_bpm"])]
    confidence = analysis.get("estimated_bpm_confidence")
    source = analysis.get("estimated_bpm_source")
    details = []
    if confidence is not None:
        details.append(f"confidence {confidence:.2f}")
    if source:
        details.append(str(source))
    if details:
        parts.append(f"({', '.join(details)})")
    return escape(" ".join(parts))


def _format_timestamp(seconds: float) -> str:
    minutes = int(seconds // 60)
    remaining_seconds = seconds - (minutes * 60)
    return f"{minutes}:{remaining_seconds:06.3f}"


def _format_metadata(metadata: dict[str, Any] | None) -> str:
    if not metadata:
        return ""
    return ", ".join(f"{escape(str(key))}: {escape(str(value))}" for key, value in metadata.items())
