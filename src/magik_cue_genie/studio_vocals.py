"""Offline full-mix vocal activity proposals. Never downloads or writes audio.

YAMNet is a general audio-event model, not a stem separator or lyric/beat model.
Its scores are evidence for auditioning a phrase, not calibrated confidence that
a loop is musically correct. All returned candidates remain unarmed.
"""
from __future__ import annotations

import hashlib
import importlib.util
import math
import os
from pathlib import Path
import sys
import time
import wave

MODEL_SHA256 = "e193da5676a2fdb7a3702c10fba62aa27d76f64e4534467443811c1a2ff1667d"
MODEL_URL = "https://storage.googleapis.com/audioset/yamnet.tflite"
MODEL_NAME = "Google YAMNet (local LiteRT)"
ROOT = Path(__file__).resolve().parents[2]
HOP_SECONDS = .48
WINDOW_SECONDS = .975
# Official YAMNet class map: singing, choir, yodel, chant, mantra, child/
# synthetic singing, rapping, humming. Do not confuse general music with vocals.
VOCAL_CLASSES = tuple(range(24, 33))


def _model_path() -> Path:
    return Path(os.environ.get("MAGIK_YAMNET_MODEL", ROOT / ".tmp/vocal-model/yamnet.tflite"))


def _runtime_path() -> Path:
    return Path(os.environ.get("MAGIK_VOCAL_RUNTIME", ROOT / ".tmp/vocal-runtime"))


def vocal_model_status() -> dict:
    """Cheap setup check; actual model validation happens only on analysis."""
    runtime = (_runtime_path() / "ai_edge_litert/interpreter.py").is_file()
    if not runtime:
        runtime = importlib.util.find_spec("ai_edge_litert") is not None
    available = _model_path().is_file() and runtime
    return {
        "status": "ready" if available else "unavailable", "model": MODEL_NAME,
        "message": "Local vocal model installed; audio stays on this computer." if available else
        "Automatic vocal detection needs one-time local setup: python scripts/setup_studio_vocals.py",
        "candidates": [],
    }


def select_vocal_candidates(scores: list[float], hop: float, duration: float) -> list[dict]:
    """Find closed 2–16s activity islands; never fabricate cuts in long vocals.

    Hysteresis requires a strong class score and a sustained region. Two quiet
    windows close the region, reducing one-frame gaps within words. The window
    receptive field limits boundary precision; listening remains mandatory.
    """
    if not math.isfinite(hop) or hop <= 0 or not math.isfinite(duration) or duration <= 0:
        return []
    clean = [min(1., max(0., s)) if math.isfinite(s) else 0. for s in scores]
    proposals = []
    start = None
    quiet = 0
    for index, score in enumerate(clean):
        if start is None:
            if score >= .45:
                start = index
            continue
        quiet = quiet + 1 if score < .25 else 0
        if quiet < 2:
            continue
        end = index - 1  # first low-activity window
        region = clean[start:end]
        begin_time = max(0., start * hop - .12)
        end_time = min(duration, end * hop + .12)
        # An open beginning is not a verified phrase boundary either.
        closed_start = start > 0 and clean[start - 1] < .25
        if closed_start and 2 <= end_time - begin_time <= 16 and region:
            mean = sum(region) / len(region)
            coverage = sum(value >= .35 for value in region) / len(region)
            if mean >= .45 and coverage >= .7:
                proposals.append({
                    "start_seconds": round(begin_time, 3), "end_seconds": round(end_time, 3),
                    "confidence": round(min(.89, mean), 3), "armed": False,
                    "beat_aligned": False, "source": "local_yamnet_full_mix",
                    "reasons": [
                        "Sustained singing/rap class evidence in the original mix.",
                        "Lower vocal activity surrounds this phrase; boundaries are approximate.",
                        "Audition the words and seam, then align to the verified beat grid before arming.",
                    ],
                })
        start, quiet = None, 0
    # An unterminated region could be an interrupted scan; never invent its end.
    return sorted(sorted(proposals, key=lambda item: -item["confidence"])[:8],
                  key=lambda item: item["start_seconds"])


def _read_window(audio, offset: float, np):
    """Read only a model window and bandlimit before resampling to mono 16 kHz."""
    rate, channels = audio.getframerate(), audio.getnchannels()
    position = min(audio.getnframes(), round(offset * rate))
    audio.setpos(position)
    raw = audio.readframes(math.ceil(WINDOW_SECONDS * rate))
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32).reshape(-1, channels).mean(axis=1) / 32768.
    if not len(samples):
        return np.zeros(15600, dtype=np.float32)
    if rate > 16000:
        # Windowed sinc low-pass avoids turning high-frequency instrumentation
        # into aliased vocal-band evidence. Fixed bounded cost, no scipy needed.
        taps = min(255, 2 * math.ceil(12 * rate / 16000) + 1)
        axis = np.arange(taps) - (taps - 1) / 2
        kernel = np.sinc(2 * 7200 / rate * axis) * np.hamming(taps)
        kernel /= kernel.sum()
        # 'full' + center crop preserves length even for a tiny final window.
        samples = np.convolve(samples, kernel, mode="full")[taps // 2:taps // 2 + len(samples)]
    positions = np.arange(15600) * rate / 16000
    return np.interp(positions, np.arange(len(samples)), samples, left=0, right=0).astype(np.float32)


def detect_vocal_loops(wav_path: Path, bpm: float | None = None) -> dict:
    """Classify a read-only PCM WAV locally, with a 40-second scan budget.

    ``bpm`` is accepted for bridge compatibility but cannot establish beat phase.
    No network calls, subprocesses, separation output, or source modifications.
    """
    status = vocal_model_status()
    if status["status"] != "ready":
        return status
    started = time.monotonic()
    try:
        model_path = _model_path()
        if model_path.stat().st_size != 16061524 or hashlib.sha256(model_path.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError("The local YAMNet model failed its integrity check. Run local setup again.")
        runtime = _runtime_path()
        if runtime.is_dir() and str(runtime) not in sys.path:
            sys.path.insert(0, str(runtime))
        import numpy as np
        from ai_edge_litert.interpreter import Interpreter

        interpreter = Interpreter(model_path=str(model_path), num_threads=2)
        interpreter.allocate_tensors()
        input_info = interpreter.get_input_details()[0]
        output_info = interpreter.get_output_details()[0]
        if tuple(input_info["shape"]) != (15600,) or tuple(output_info["shape"]) != (1, 521):
            raise ValueError("The local vocal model has an unsupported input/output contract.")
        scores = []
        with wave.open(str(wav_path), "rb") as audio:
            if audio.getsampwidth() != 2 or audio.getnchannels() not in (1, 2) or audio.getcomptype() != "NONE":
                raise ValueError("Vocal detection requires decoded 16-bit mono/stereo PCM WAV.")
            duration = audio.getnframes() / audio.getframerate()
            if not 0 < duration <= 1800:
                raise ValueError("Local vocal detection supports tracks up to 30 minutes.")
            count = max(1, math.ceil(max(0, duration - WINDOW_SECONDS) / HOP_SECONDS) + 1)
            for index in range(count):
                if time.monotonic() - started >= 40:
                    break
                samples = _read_window(audio, index * HOP_SECONDS, np)
                interpreter.set_tensor(input_info["index"], samples)
                interpreter.invoke()
                result = interpreter.get_tensor(output_info["index"])[0]
                scores.append(float(np.max(result[list(VOCAL_CLASSES)])))
        candidates = select_vocal_candidates(scores, HOP_SECONDS, duration)
        partial = len(scores) < count
        message = "Local full-mix vocal analysis complete. Audition suggestions before arming." if candidates else "No clearly bounded vocal phrase found; no vocal loop was invented."
        if partial:
            message = "Local scan reached its time budget; suggestions cover only the analyzed beginning. " + message
        return {
            "status": "ready", "model": MODEL_NAME, "message": message,
            "candidates": candidates, "partial": partial,
            "analyzed_seconds": round(min(duration, max(0, len(scores) - 1) * HOP_SECONDS + WINDOW_SECONDS), 3),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "boundary_precision_seconds": WINDOW_SECONDS,
        }
    except Exception as error:
        # Optional inference must never prevent basic cue analysis. Do not expose
        # interpreter internals or local paths in the UI.
        message = str(error) if isinstance(error, ValueError) else "Local vocal inference could not run. Check the local model/runtime setup."
        return {"status": "error", "model": MODEL_NAME, "message": message, "candidates": []}
