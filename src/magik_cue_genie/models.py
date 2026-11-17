from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
SUPPORTED_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".aiff", ".aif", ".m4a"}


@dataclass(frozen=True)
class EnergySummary:
    window_size_seconds: float
    max_rms: float
    mean_rms: float
    normalized_envelope: list[float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "window_size_seconds": self.window_size_seconds,
            "max_rms": self.max_rms,
            "mean_rms": self.mean_rms,
            "normalized_envelope": self.normalized_envelope,
        }


@dataclass(frozen=True)
class AnalysisSummary:
    duration_seconds: float | None = None
    estimated_bpm: float | None = None
    estimated_bpm_confidence: float | None = None
    estimated_bpm_source: str | None = None
    bpm_debug: dict[str, Any] | None = None
    beat_debug: dict[str, Any] | None = None
    tempo_candidates_debug: dict[str, Any] | None = None
    estimated_key: str | None = None
    energy_summary: EnergySummary | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "duration_seconds": self.duration_seconds,
            "estimated_bpm": self.estimated_bpm,
            "estimated_bpm_confidence": self.estimated_bpm_confidence,
            "estimated_bpm_source": self.estimated_bpm_source,
            "bpm_debug": self.bpm_debug,
            "estimated_key": self.estimated_key,
            "energy_summary": self.energy_summary.to_dict() if self.energy_summary else None,
        }

    def to_report_dict(self) -> dict[str, Any]:
        data = self.to_dict()
        data["beat_debug"] = self.beat_debug
        data["tempo_candidates_debug"] = self.tempo_candidates_debug
        return data


@dataclass(frozen=True)
class CueSuggestion:
    label: str
    time_seconds: float
    confidence: float
    reason: str
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        data = {
            "label": self.label,
            "time_seconds": self.time_seconds,
            "confidence": self.confidence,
            "reason": self.reason,
        }
        if self.metadata:
            data["metadata"] = self.metadata
        return data


@dataclass(frozen=True)
class TrackSidecar:
    source_file: str
    analysis: AnalysisSummary = field(default_factory=AnalysisSummary)
    cues: list[CueSuggestion] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION

    @classmethod
    def placeholder_for(cls, audio_path: Path, warnings: list[str] | None = None) -> "TrackSidecar":
        return cls(source_file=audio_path.name, warnings=warnings or [])

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "source_file": self.source_file,
            "analysis": self.analysis.to_dict(),
            "cues": [cue.to_dict() for cue in self.cues],
            "warnings": self.warnings,
        }


@dataclass(frozen=True)
class AnalyzeResult:
    audio_path: Path
    sidecar_path: Path
    sidecar: TrackSidecar


@dataclass(frozen=True)
class SkippedFile:
    source_file: str
    reason: str
    detail: str | None = None


def is_supported_audio_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS
