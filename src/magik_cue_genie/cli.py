from __future__ import annotations

from pathlib import Path

import typer

from .analysis import AnalysisProfile, analyze_audio, get_analysis_settings_profile
from .feedback import load_feedback_json
from .models import AnalyzeResult, SkippedFile, is_supported_audio_file
from .reference import load_reference_csv
from .report import write_report
from .sidecar import sidecar_path_for, write_sidecar

app = typer.Typer(help="Safe local DJ cue suggestion scaffold.")


@app.callback()
def main() -> None:
    """Magik-cue-genie command group."""


@app.command()
def analyze(
    input_path: Path = typer.Argument(..., help="Audio file or directory to analyze."),
    output: Path = typer.Option(
        ...,
        "--output",
        "-o",
        help="Directory where JSON sidecars and the HTML report will be written.",
    ),
    profile: AnalysisProfile = typer.Option(
        AnalysisProfile.BALANCED,
        "--profile",
        help="Named analysis profile for cue heuristic tuning.",
    ),
    reference_csv: Path | None = typer.Option(
        None,
        "--reference-csv",
        help="Optional CSV with reference source_file, reference_bpm, reference_key, and notes columns.",
    ),
    feedback_json: Path | None = typer.Option(
        None,
        "--feedback-json",
        help="Optional previously exported review feedback JSON for report-only comparison.",
    ),
) -> None:
    """Analyze supported audio files and emit placeholder sidecars."""
    input_path = input_path.resolve()
    output = output.resolve()

    if not input_path.exists():
        raise typer.BadParameter(f"Input path does not exist: {input_path}")
    if reference_csv is not None:
        reference_csv = reference_csv.resolve()
        if not reference_csv.exists():
            raise typer.BadParameter(f"Reference CSV does not exist: {reference_csv}")
    if feedback_json is not None:
        feedback_json = feedback_json.resolve()
        if not feedback_json.exists():
            raise typer.BadParameter(f"Feedback JSON does not exist: {feedback_json}")
    if input_path.is_file() and output == input_path.parent:
        typer.echo("Using the source directory as output; source audio will not be modified.")

    audio_files, skipped_files = collect_audio_files(input_path)
    analysis_settings = get_analysis_settings_profile(profile)
    references = load_reference_csv(reference_csv) if reference_csv is not None else None
    previous_feedback = load_feedback_json(feedback_json) if feedback_json is not None else None
    warnings: list[str] = []
    output.mkdir(parents=True, exist_ok=True)

    results: list[AnalyzeResult] = []
    for audio_file in audio_files:
        analysis_result = analyze_audio(audio_file, settings=analysis_settings)
        if analysis_result.warning:
            warnings.append(analysis_result.warning)
        if analysis_result.skipped_file:
            skipped_files.append(analysis_result.skipped_file)
        if analysis_result.sidecar is None:
            continue

        sidecar = analysis_result.sidecar
        sidecar_path = sidecar_path_for(audio_file, output)
        write_sidecar(sidecar, sidecar_path)
        results.append(AnalyzeResult(audio_path=audio_file, sidecar_path=sidecar_path, sidecar=sidecar))
        typer.echo(f"Wrote sidecar: {sidecar_path}")

    html_report_path, json_report_path = write_report(
        results,
        skipped_files,
        output,
        analysis_settings=analysis_settings,
        analysis_profile=profile,
        references=references,
        previous_feedback=previous_feedback,
    )
    for warning in warnings:
        typer.echo(f"Warning: {warning}", err=True)
    for skipped_file in skipped_files:
        detail = f" ({skipped_file.detail})" if skipped_file.detail else ""
        typer.echo(f"Skipped {skipped_file.source_file}: {skipped_file.reason}{detail}", err=True)
    typer.echo(f"Wrote report: {html_report_path}")
    typer.echo(f"Wrote report: {json_report_path}")


def collect_audio_files(input_path: Path) -> tuple[list[Path], list[SkippedFile]]:
    if input_path.is_file():
        if is_supported_audio_file(input_path):
            return [input_path], []
        return [], [SkippedFile(source_file=input_path.name, reason="Unsupported file extension", detail=input_path.suffix)]

    if not input_path.is_dir():
        return [], [SkippedFile(source_file=input_path.name, reason="Input is not a file or directory")]

    audio_files: list[Path] = []
    skipped_files: list[SkippedFile] = []
    for child in sorted(input_path.iterdir()):
        if child.is_dir():
            continue
        if is_supported_audio_file(child):
            audio_files.append(child)
        else:
            skipped_files.append(
                SkippedFile(source_file=child.name, reason="Unsupported file extension", detail=child.suffix)
            )
    return audio_files, skipped_files
