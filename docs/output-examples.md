# Output Examples

These examples show representative JSON output shapes for schema version 1. Values are illustrative.

## Per-Track Sidecar

```json
{
  "schema_version": 1,
  "source_file": "example.wav",
  "analysis": {
    "duration_seconds": 180.0,
    "estimated_bpm": 120.0,
    "estimated_bpm_confidence": 0.875,
    "estimated_bpm_source": "rms_onset_interval",
    "bpm_debug": {
      "source": "rms_onset_interval",
      "status": "accepted",
      "onset_times_seconds": [0.5, 1.0, 1.5, 2.0],
      "intervals_seconds": [0.5, 0.5, 0.5],
      "candidate_bpms": [120.0, 120.0, 120.0],
      "selected_bpm": 120.0,
      "confidence": 0.875,
      "reason": "Stable RMS onset intervals produced a BPM estimate."
    },
    "estimated_key": null,
    "energy_summary": {
      "window_size_seconds": 0.25,
      "max_rms": 0.72,
      "mean_rms": 0.31,
      "normalized_envelope": [0.0, 0.12, 0.85, 0.9, 0.42]
    }
  },
  "cues": [
    {
      "label": "intro",
      "time_seconds": 0.5,
      "confidence": 0.35,
      "reason": "Heuristic: first sustained non-silent RMS energy region; not beat- or phrase-aware.",
      "metadata": {
        "heuristic": "first_sustained_energy"
      }
    },
    {
      "label": "energy_shift",
      "time_seconds": 64.0,
      "confidence": 0.25,
      "reason": "Heuristic: notable RMS energy rise; not beat- or phrase-aware.",
      "metadata": {
        "heuristic": "rms_energy_shift",
        "direction": "rise",
        "delta": 0.63
      }
    },
    {
      "label": "outro",
      "time_seconds": 168.5,
      "confidence": 0.3,
      "reason": "Heuristic: final sustained RMS energy region before fade or end; not beat- or phrase-aware.",
      "metadata": {
        "heuristic": "final_sustained_energy"
      }
    }
  ],
  "warnings": []
}
```

## Aggregate Report

```json
{
  "schema_version": 1,
  "analysis_profile": "balanced",
  "analysis_settings": {
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
    "max_energy_shift_cues": 3
  },
  "analyzed_tracks": [
    {
      "source_file": "example.wav",
      "sidecar_file": "example.magik-cue-genie.json",
      "analysis": {
        "duration_seconds": 180.0,
        "estimated_bpm": 120.0,
        "estimated_bpm_confidence": 0.875,
        "estimated_bpm_source": "rms_onset_interval",
        "bpm_debug": {
          "source": "rms_onset_interval",
          "status": "accepted",
          "onset_times_seconds": [0.5, 1.0, 1.5, 2.0],
          "intervals_seconds": [0.5, 0.5, 0.5],
          "candidate_bpms": [120.0, 120.0, 120.0],
          "selected_bpm": 120.0,
          "confidence": 0.875,
          "reason": "Stable RMS onset intervals produced a BPM estimate."
        },
        "estimated_key": null,
        "energy_summary": {
          "window_size_seconds": 0.25,
          "max_rms": 0.72,
          "mean_rms": 0.31,
          "normalized_envelope": [0.0, 0.12, 0.85, 0.9, 0.42]
        }
      },
      "cues": [
        {
          "label": "intro",
          "time_seconds": 0.5,
          "confidence": 0.35,
          "reason": "Heuristic: first sustained non-silent RMS energy region; not beat- or phrase-aware.",
          "metadata": {
            "heuristic": "first_sustained_energy"
          }
        }
      ],
      "warnings": []
    }
  ],
  "skipped_files": [
    {
      "source_file": "notes.txt",
      "reason": "Unsupported file extension",
      "detail": ".txt"
    }
  ],
  "summary": {
    "analyzed_count": 1,
    "skipped_count": 1,
    "cue_count": 1,
    "warning_count": 0,
    "bpm": {
      "accepted_count": 1,
      "rejected_count": 0,
      "insufficient_onsets_count": 0,
      "missing_debug_count": 0,
      "estimated_count": 1
    }
  }
}
```
