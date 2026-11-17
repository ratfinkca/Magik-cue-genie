"""Bounded analysis of a Studio-owned temporary upload; no output files or DJ writes."""
from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
from dataclasses import replace
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

from .analysis import analyze_audio
from .models import AnalysisSummary, SUPPORTED_AUDIO_EXTENSIONS, TrackSidecar
from .studio_beat_this import beat_this_prediction
from .studio_rhythm import analyze_studio_rhythm, empty_studio_rhythm
from .studio_vocals import detect_vocal_loops

MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_DECODED_BYTES = 512 * 1024 * 1024
MAX_DURATION_SECONDS = 30 * 60
DECODE_FORMATS = {".wav": "wav", ".mp3": "mp3", ".m4a": "mov", ".flac": "flac", ".aif": "aiff", ".aiff": "aiff"}


class AnalysisInputError(ValueError):
    """A user-facing upload or decoding limitation."""


def _wav_needs_conversion(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as audio:
            return audio.getsampwidth() != 2 or audio.getnchannels() not in {1, 2} or audio.getcomptype() != "NONE"
    except (EOFError, wave.Error):
        # Includes float WAV, unsupported by Python's wave module. FFmpeg validates it.
        return True


def _check_wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as audio:
            if audio.getframerate() <= 0 or audio.getnframes() <= 0:
                raise AnalysisInputError("The file has no playable audio.")
            duration = audio.getnframes() / audio.getframerate()
            if duration > MAX_DURATION_SECONDS:
                raise AnalysisInputError("Studio analysis currently supports tracks up to 30 minutes.")
            return duration
    except (EOFError, wave.Error) as error:
        raise AnalysisInputError("The WAV could not be read. Use an uncompressed 16-bit PCM WAV file.") from error


def _add_studio_suggestions(payload: dict, audio_path: Path) -> None:
    analysis = payload["analysis"]
    try:
        rhythm = analyze_studio_rhythm(audio_path)
    except Exception:
        rhythm = empty_studio_rhythm("error")
        rhythm["warnings"].append("The rhythm analysis did not finish.")
    tempo, grid = rhythm["tempo"], rhythm["grid"]
    analysis.update(
        estimated_bpm=tempo["bpm"],
        estimated_bpm_source=tempo["source"] if tempo["bpm"] is not None else None,
        estimated_bpm_confidence=tempo["confidence"] if tempo["bpm"] is not None else None,
        bpm_debug=None,
        studio_tempo=tempo,
        studio_beatgrid=grid,
    )
    payload["warnings"].extend(rhythm["warnings"])
    if len(grid["beat_times_seconds"]) < 2:
        predicted = beat_this_prediction(audio_path, analysis["duration_seconds"])
        if predicted:
            analysis["studio_model_grid"] = predicted
            if predicted["status"] == "predicted":
                payload["warnings"].append("Beat This predicted a display grid. Measured beat positions remain unverified.")
                if analysis["estimated_bpm"] is None:
                    analysis.update(estimated_bpm=predicted["bpm"], estimated_bpm_source=predicted["source"])
            else:
                payload["warnings"].append("The optional local Beat This model reached its time limit."
                                           if predicted.get("reason") == "timeout"
                                           else "The optional local Beat This model did not finish.")
    labels = {
        "first_pulse": "First pulse", "energy_rise": "Energy rises", "energy_fall": "Energy falls",
        "mix_in": "Mix in", "mix_out": "Mix out",
    }
    payload["cues"] = [{**cue, "label": labels.get(cue["label"], cue["label"])} for cue in rhythm["cues"]]

    try:
        vocal = detect_vocal_loops(audio_path, tempo["bpm"])
        vocal_cues = _vocal_cues(vocal, grid["beat_times_seconds"], analysis["duration_seconds"])
    except Exception:
        vocal = {"status": "error", "message": "The local vocal analysis did not finish."}
        vocal_cues = []
    analysis["studio_vocals"] = {key: value for key, value in vocal.items() if key != "candidates"}
    payload["cues"].extend(vocal_cues)
    payload["cues"].sort(key=lambda cue: cue["time_seconds"])
    rhythm_status = rhythm["cue_status"]
    vocal_status = "partial" if vocal.get("partial") else vocal["status"]
    stage_statuses = {rhythm_status, vocal_status}
    if "partial" in stage_statuses or ("error" in stage_statuses and payload["cues"]):
        status = "partial"
    elif "error" in stage_statuses:
        status = "error"
    else:
        status = "ready" if payload["cues"] else "unavailable"
    analysis["studio_cues"] = {"status": status, "rhythm_status": rhythm_status,
                               "vocal_status": vocal_status, "count": len(payload["cues"])}


def _vocal_cues(vocal: dict, beats: list[float], duration: float) -> list[dict]:
    cues = []
    if vocal["status"] != "ready":
        return cues
    candidates = sorted(vocal["candidates"], key=lambda item: item["confidence"], reverse=True)[:2]
    for candidate in candidates:
        start, end, score = (candidate[key] for key in ("start_seconds", "end_seconds", "confidence"))
        if not all(math.isfinite(value) for value in (start, end, score)) or not 0 <= start < end <= duration:
            continue
        # Snap outward to supported nearby beats. Never trim a detected passage
        # to force alignment, or imply bar/downbeat information.
        before, after = bisect_right(beats, start) - 1, bisect_left(beats, end)
        aligned = before >= 0 and after < len(beats) and start - beats[before] <= .2 and beats[after] - end <= .2
        if aligned:
            start, end = beats[before], beats[after]
        cues.append({
            "label": "Vocal loop",
            "time_seconds": round(start, 4),
            "confidence": min(.8, max(0., score)),
            "reason": ("Vocal activity detected in the full track. Boundaries use nearby observed beats. Audition the seam."
                       if aligned else "Vocal activity detected in the full track. Audition the phrase and its approximate boundaries."),
            "metadata": {
                "requires_review": True,
                "beat_aligned": aligned,
                "loop_method": candidate["source"],
                "loop": {"end_seconds": round(end, 4), "active": False, "kind": "vocal"},
            },
        })
    return cues


def analyze_uploaded_copy(path: Path, source_name: str) -> dict:
    """The web bridge supplies a fixed temporary path, never a client-supplied path."""
    if not source_name or len(source_name.encode("utf-8")) > 255 or any(
        character in source_name for character in '/\\:\x00'
    ) or any(ord(character) < 32 for character in source_name):
        raise AnalysisInputError("Send an audio filename, not a filesystem path.")
    suffix = Path(source_name).suffix.lower()
    if suffix not in SUPPORTED_AUDIO_EXTENSIONS:
        raise AnalysisInputError("Supported audio: WAV, MP3, M4A, FLAC, AIFF, and AIF.")
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_UPLOAD_BYTES:
        raise AnalysisInputError("Select a non-empty audio file no larger than 100 MiB.")

    analysis_path = path
    decoded_path: Path | None = None
    decode_directory: tempfile.TemporaryDirectory | None = None
    warnings: list[str] = []
    try:
        if suffix != ".wav" or _wav_needs_conversion(path):
            decode_directory = tempfile.TemporaryDirectory(prefix="decoded-", dir=path.parent)
            decoded_path = Path(decode_directory.name) / "audio.wav"
            try:
                # Force the intended demuxer and deny network protocols/playlist traversal.
                # -n protects the temporary output too; duration and output size bound decoding.
                subprocess.run(
                    [
                        os.environ.get("MAGIK_FFMPEG", "ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
                        "-protocol_whitelist", "file,pipe", "-f", DECODE_FORMATS[suffix], "-i", str(path),
                        "-map", "0:a:0", "-vn", "-sn", "-dn", "-acodec", "pcm_s16le", "-ac", "2",
                        "-t", str(MAX_DURATION_SECONDS + 1), "-fs", str(MAX_DECODED_BYTES), str(decoded_path),
                    ],
                    check=True, capture_output=True, timeout=60,
                )
            except FileNotFoundError as error:
                raise AnalysisInputError("FFmpeg is required for this format. Install FFmpeg or choose a 16-bit PCM WAV.") from error
            except OSError as error:
                raise AnalysisInputError("FFmpeg could not start. Check its installation or choose a 16-bit PCM WAV.") from error
            except subprocess.TimeoutExpired as error:
                raise AnalysisInputError("Audio decoding took too long. Try a shorter track or a PCM WAV file.") from error
            except subprocess.CalledProcessError as error:
                raise AnalysisInputError("FFmpeg could not decode this audio file. Try another file or a PCM WAV export.") from error
            if decoded_path.stat().st_size >= MAX_DECODED_BYTES:
                raise AnalysisInputError("The decoded audio exceeds Studio's temporary storage limit.")
            analysis_path = decoded_path
            warnings.append("Temporary ffmpeg decode used for WAV analysis; source audio was not modified.")

        duration = _check_wav_duration(analysis_path)
        base_status = "ready"
        try:
            result = analyze_audio(analysis_path, include_cues=False)
        except Exception:
            base_status = "error"
            sidecar = TrackSidecar(source_file=source_name, analysis=AnalysisSummary(duration_seconds=duration),
                                   warnings=[*warnings, "The energy summary did not finish."])
        else:
            if result.sidecar is None or result.sidecar.analysis.duration_seconds is None:
                raise AnalysisInputError("Audio analysis is unavailable for this file. Try an uncompressed 16-bit PCM WAV.")
            sidecar = replace(result.sidecar, source_file=source_name, warnings=[*result.sidecar.warnings, *warnings])
        payload = sidecar.to_dict()
        payload["analysis"]["studio_base"] = {"status": base_status}
        _add_studio_suggestions(payload, analysis_path)
        return {"sidecar": payload}
    finally:
        if decode_directory is not None:
            decode_directory.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    try:
        result = analyze_uploaded_copy(args.input, args.name)
    except (AnalysisInputError, OSError):
        error = sys.exception()
        message = str(error) if isinstance(error, AnalysisInputError) else "The temporary audio file could not be read."
        print(json.dumps({"error": message}, ensure_ascii=True))
        return 1
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
