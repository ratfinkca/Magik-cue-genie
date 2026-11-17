# Magik-cue-genie

Magik-cue-genie is a local-first DJ cue suggestion tool. The MVP analyzes local audio files and produces reviewable cue-point suggestions for Engine DJ preparation without modifying audio files or writing to any DJ software database.

## Project Plan

### Milestone 1: Safe CLI Prototype

Build a command-line tool that:

- Accepts one audio file or a directory of audio files.
- Analyzes each file locally.
- Suggests useful cue points such as intro, first downbeat, breakdown, drop, outro, and energy changes.
- Writes JSON sidecar files next to, or inside a chosen output directory for, the analyzed tracks.
- Generates a simple HTML report summarizing cue suggestions.
- Uses generated synthetic audio fixtures for automated tests.

This milestone must not:

- Modify original audio files.
- Write to Engine DJ, Mixxx, Rekordbox, Serato, or other DJ library databases.
- Require copyrighted sample tracks.

### Milestone 2: Review Workflow

Improve the prototype so users can inspect and refine suggestions before any future export step:

- Add clearer confidence scores and reasons for each cue.
- Add report filtering and sorting.
- Add configuration for cue labels, max cue count, and output paths.
- Add regression tests using synthetic audio patterns.

### Milestone 3: Export Research

Research export formats and database integrations without writing to production DJ libraries:

- Document Engine DJ database structure and risks.
- Prototype export into isolated test fixtures only.
- Define backup and rollback requirements before any database-writing feature.

## Proposed Initial Tech Stack

- Python for the CLI and analysis code.
- Typer for command-line interface ergonomics.
- pytest for automated tests.
- JSON sidecar files for machine-readable cue suggestions.
- Jinja2 or simple static HTML generation for reports.
- librosa for audio analysis experiments once the scaffold is ready.
- ffmpeg or soundfile/audioread as needed for file decoding support.

The first implementation should start small: parse inputs, validate paths, emit placeholder JSON/report structures, and test behavior using generated synthetic audio. Deeper signal analysis can be added after the output contract is stable.

## How To Run

The current implementation is a safe runnable scaffold. It validates file paths, discovers supported audio file extensions, writes JSON sidecars, and creates a simple HTML report. WAV files get real `duration_seconds` values and a basic RMS `energy_summary` from Python's built-in `wave` module. Supported non-WAV files (`.mp3`, `.m4a`, `.flac`, `.aiff`, and `.aif`) can be analyzed when `ffmpeg` is installed: the CLI decodes them to temporary 16-bit PCM WAV files, analyzes those temporary files, then deletes them. Key, beat grid, and phrase detection are not implemented yet.

The current WAV energy summary supports common uncompressed 16-bit PCM mono/stereo files. It stores a compact summary with `window_size_seconds`, `max_rms`, `mean_rms`, and a normalized envelope rather than a full waveform.

The cue heuristics currently implemented are conservative `intro`, `outro`, and generic `energy_shift` candidates for WAV files. The `intro` cue looks for a sustained transition from silence or very low energy into meaningful audio near the beginning of the track. The `outro` cue looks for a useful point inside the final sustained energy region before a fade or ending, and is constrained to the final track region by the active analysis settings. `energy_shift` cues mark notable RMS energy changes, capped at three per track, and their reason notes whether the change is an energy rise or energy drop. Cue entries may include optional `metadata` with machine-readable heuristic details. These are energy-envelope heuristics only, not beat-aware or phrase-aware, and they do not attempt breakdown, build, or drop detection yet. Silence-only files produce no cues.

Preliminary BPM reporting uses a simple RMS onset-interval heuristic and is shown only when confidence is high enough. BPM is currently for review/reporting only; cue snapping and phrase detection do not use it yet. `report.html` includes compact per-track Diagnostics, BPM Debug, Beat / Onset Diagnostics, and Tempo Candidate Diagnostics sections plus aggregate BPM debug counts. `report.json` includes `analysis.bpm_debug`, `analysis.beat_debug`, `analysis.tempo_candidates_debug`, and `summary.bpm`, to help tune local BPM analysis before beat- or phrase-aware cue placement is added.

Sidecars include a top-level `warnings` list for non-fatal limitations and caveats. For example, supported non-WAV files warn when temporary ffmpeg decoding was used, or when ffmpeg is unavailable or decoding fails. Track warnings are also shown in the HTML report.

Unsupported files and malformed WAV files are represented separately in the reports as skipped files with `source_file`, `reason`, and optional `detail`. They do not receive JSON sidecars. Supported non-WAV files receive analyzed sidecars when ffmpeg decoding succeeds, or placeholder sidecars with track warnings when ffmpeg is unavailable or decoding fails.

Each run writes both `report.html` for human review and `report.json` for automated tooling. The aggregate JSON report includes `schema_version`, `analyzed_tracks`, `skipped_files`, and summary counts for analyzed tracks, skipped files, cues, and warnings.

Schema compatibility rules are documented in [docs/schema-versioning.md](docs/schema-versioning.md).
Representative output shapes are shown in [docs/output-examples.md](docs/output-examples.md).

Install the package in editable mode:

```powershell
python -m pip install -e ".[dev]"
```

Analyze one file or a directory:

```powershell
magik-cue-genie analyze .\music --output .\cue-output
```

Choose a named cue heuristic profile:

```powershell
magik-cue-genie analyze .\music --output .\cue-output --profile sensitive
```

Available profiles are `balanced` (default), `conservative`, and `sensitive`. `balanced` uses the default analysis settings. `conservative` requires stronger or more sustained energy before emitting cues and caps energy-shift cues lower. `sensitive` uses a lower energy threshold and fewer sustained windows, so it is more willing to emit heuristic cues. The selected profile is recorded as `analysis_profile` in `report.json`, and the effective numeric settings, including `max_energy_shift_cues`, are recorded as `analysis_settings`.

For manual QA, you can add reference facts to `report.html` and `report.json` without changing analysis or sidecars:

```powershell
magik-cue-genie analyze .\music --output .\cue-output --reference-csv .\reference.csv
```

The reference CSV columns are `source_file`, `reference_bpm`, `reference_key`, and `notes`. Rows match analyzed tracks by source-file basename, case-insensitive.

## Demo

Generate synthetic WAV files for reproducible local demos:

```powershell
python .\scripts\make_demo_audio.py
```

Analyze the generated files:

```powershell
magik-cue-genie analyze .\demo-audio --output .\cue-output
```

Open `.\cue-output\report.html` in a browser to review the intro, outro, energy-shift, and silence-only examples. The generated `demo-audio` directory is ignored by git.

## Reviewing Cue Quality

Open `report.html` from the output directory and use the Review / Reference area plus the Review column for each cue. Ratings can be blank, `good`, `early`, `late`, `wrong`, or `maybe`; optional notes can be added beside each rating. Use **Download review feedback** to export a browser-generated JSON feedback file. The export does not modify source audio, sidecar JSON, or `report.json`.

Summarize a downloaded review feedback file:

```powershell
python .\scripts\summarize_review_feedback.py .\magik-cue-genie-review-feedback.json
```

Review workflow:

1. Generate a report with `magik-cue-genie analyze`.
2. Review cues in `report.html`.
3. Download `magik-cue-genie-review-feedback.json`.
4. Run the summary script above.
5. Optionally rerun the report with previous feedback for a read-only comparison overlay:

```powershell
magik-cue-genie analyze .\real-audio-test --output .\real-cue-output --profile balanced --feedback-json .\magik-cue-genie-review-feedback.json
```

When previous feedback includes reference BPM/key/source values, `report.html` also shows a diagnostic detected-vs-reference comparison and flags possible half-time or double-time BPM estimates. This is for review only and does not affect analysis or cue placement.

Cue quality is still heuristic and energy-envelope based. The current cues are not beat-aware or phrase-aware yet.

Run tests:

```powershell
python -m pytest
```

On Windows, if pytest temp files need to stay inside the project folder:

```powershell
$env:TMP = "$PWD\.tmp"; $env:TEMP = "$PWD\.tmp"; python -m pytest --basetemp .\.tmp\pytest
```

Or run the helper script:

```powershell
.\scripts\test.ps1
```

## Safety Principles

- Treat source audio as read-only.
- Write only to explicit output paths or clearly named sidecar files.
- Never write to DJ software databases during the MVP.
- Keep generated suggestions explainable and easy to review.
- Prefer small, reviewable changes over broad rewrites.
