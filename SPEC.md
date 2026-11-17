# MVP Specification

## Product Summary

Magik-cue-genie suggests DJ cue points for local audio files. The MVP is a safe command-line prototype for Engine DJ preparation workflows, producing reviewable JSON sidecars and a simple HTML report. It does not write to Engine DJ or any other DJ software database.

## MVP Goals

- Analyze local audio files from a file path or directory.
- Suggest musically useful cue points.
- Output one JSON sidecar per analyzed track.
- Output a simple HTML report for human review.
- Run locally without cloud dependencies.
- Support automated tests using generated synthetic audio.

## Non-Goals

- No modification of original audio files.
- No writes to Engine DJ databases.
- No writes to Mixxx, Rekordbox, Serato, or other DJ software databases.
- No reliance on copyrighted sample tracks for tests.
- No production-grade cue import/export workflow yet.
- No guarantee that suggestions are correct without user review.

## Proposed Cue Labels

The MVP should support a small, practical cue vocabulary:

- `intro`: Beginning of usable mix-in material.
- `first_downbeat`: First strong beat or phrase start.
- `vocal_in`: Start of prominent vocal content.
- `breakdown`: Lower-energy section or arrangement break.
- `build`: Rising-energy section before a drop or return.
- `drop`: High-energy section entrance.
- `outro`: Beginning of usable mix-out material.
- `energy_shift`: Notable change in intensity, density, or rhythm.

Each suggested cue should include:

- Label.
- Time in seconds.
- Confidence score.
- Short reason.
- Optional phrase or bar estimate when available.

## JSON Sidecar Shape

Initial sidecars should be easy to inspect and stable enough for tests:

```json
{
  "schema_version": 1,
  "source_file": "example.wav",
  "analysis": {
    "duration_seconds": 300.0,
    "estimated_bpm": 128.0,
    "estimated_key": null
  },
  "cues": [
    {
      "label": "first_downbeat",
      "time_seconds": 12.34,
      "confidence": 0.82,
      "reason": "Detected strong onset near phrase boundary"
    }
  ]
}
```

## HTML Report

The report should show:

- Track filename.
- Duration.
- Estimated BPM if available.
- Suggested cues sorted by time.
- Cue label, timestamp, confidence, and reason.
- Any warnings or files skipped.

The report is for review only and should not imply cues have been imported into Engine DJ.

## Acceptance Criteria

- The CLI can analyze a single generated synthetic audio file and emit a JSON sidecar.
- The CLI can analyze a directory of generated synthetic audio files.
- Original audio files remain unchanged.
- The HTML report is generated from the same cue suggestion data as the JSON sidecars.
- Tests do not require copyrighted media.
- Tests can run with `pytest`.
- The README explains current status, safety constraints, and how to run the project.

## Assumptions

- The first implementation will target Python 3.11 or newer unless project constraints require otherwise.
- Early cue detection may be approximate and should prioritize explainability over cleverness.
- Engine DJ integration is intentionally deferred until the safe local output workflow is proven.
