# AGENTS.md

## Project Context

Magik-cue-genie is a local-first DJ cue suggestion tool. The first milestone is a safe CLI prototype that analyzes local audio files and outputs JSON sidecar files plus a simple HTML report.

## Hard Constraints

- Do not modify original audio files.
- Do not write to Engine DJ, Mixxx, Rekordbox, Serato, or other DJ software databases.
- Do not assume access to copyrighted sample tracks.
- Use generated synthetic audio for automated tests.
- Keep changes small and reviewable.
- Ask clarifying questions only when blocked; otherwise make reasonable assumptions and document them.

## Preferred Stack

- Python
- Typer for CLI commands
- pytest for tests
- JSON sidecar output
- Jinja2 or simple static HTML reports
- librosa, soundfile, audioread, or ffmpeg only when needed for audio analysis and decoding

## Coding Guidance

- Start with simple, explicit data models before adding abstractions.
- Keep analysis, output writing, report rendering, and CLI parsing separated.
- Prefer deterministic behavior in tests.
- Build tests around generated synthetic audio, not external music files.
- Validate paths carefully and fail with clear messages.
- Make output paths explicit and predictable.
- Include confidence scores and short reasons for suggested cue points once analysis begins.

## Safety Guidance

- Treat every input audio path as read-only.
- When writing sidecars, avoid overwriting existing files unless the CLI explicitly supports and documents that behavior.
- Keep any future database-related work isolated behind explicit non-MVP tasks and test fixtures.
- Do not add Engine DJ write behavior until backup, rollback, schema, and acceptance criteria are documented.

## Suggested Repository Shape

```text
magik_cue_genie/
  __init__.py
  cli.py
  analysis.py
  models.py
  sidecar.py
  report.py
tests/
  test_cli.py
  test_sidecar.py
  test_synthetic_audio.py
README.md
SPEC.md
AGENTS.md
pyproject.toml
```

This structure is a suggestion, not a mandate. Follow existing project structure if one is later introduced.
