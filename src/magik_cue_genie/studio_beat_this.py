"""Optional offline Beat This runner for display-only predictions."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from statistics import median
import subprocess

SMALL0_SHA256 = "6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b"
PREDICTED_GRID_SOURCE = "beat_this_small0"


def beat_this_prediction(audio_path: Path, duration: float) -> dict | None:
    """Use a configured local worker only for tracks with no observed grid."""
    python = os.environ.get("MAGIK_BEAT_THIS_PYTHON")
    checkpoint = os.environ.get("MAGIK_BEAT_THIS_CHECKPOINT")
    if not python or not checkpoint or not 8 <= duration <= 600:
        return None
    try:
        completed = subprocess.run(
            [python, "-B", "-m", "magik_cue_genie.studio_beat_this",
             "--input", str(audio_path), "--checkpoint", checkpoint],
            check=True, capture_output=True, timeout=50,
        )
        prediction = json.loads(completed.stdout)
    except subprocess.TimeoutExpired:
        return {"status": "error", "source": PREDICTED_GRID_SOURCE, "reason": "timeout"}
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"status": "error", "source": PREDICTED_GRID_SOURCE}
    if prediction is None:
        return None
    beats = prediction.get("beats") if isinstance(prediction, dict) else None
    if not isinstance(beats, list) or not 8 <= len(beats) <= 16_384:
        return {"status": "error", "source": PREDICTED_GRID_SOURCE}
    previous = -1.
    clean = []
    for beat in beats:
        if type(beat) not in (int, float) or not math.isfinite(beat) or not previous < beat or not 0 <= beat <= duration + .025:
            return {"status": "error", "source": PREDICTED_GRID_SOURCE}
        previous = beat
        if beat <= duration:
            clean.append(beat)
    intervals = [last - first for first, last in zip(clean, clean[1:])]
    if len(intervals) < 7:
        return None
    period = median(intervals)
    nearby = [interval for interval in intervals if abs(interval - period) <= .15 * period]
    bpm = 60 / (math.fsum(nearby) / len(nearby) if len(nearby) >= .65 * len(intervals) else period)
    if not 20 <= bpm <= 400:
        return None
    return {"status": "predicted", "source": PREDICTED_GRID_SOURCE, "bpm": round(bpm, 2),
            "beat_times_seconds": clean, "downbeat_verified": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    args = parser.parse_args()
    checkpoint = args.checkpoint.resolve(strict=True)
    with checkpoint.open("rb") as weights:
        if hashlib.file_digest(weights, "sha256").hexdigest() != SMALL0_SHA256:
            parser.error("Expected a verified Beat This small0 checkpoint.")

    import numpy as np
    import soundfile as sf
    import torch
    from beat_this.inference import Audio2Beats

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    with sf.SoundFile(args.input) as source:
        sample_rate = source.samplerate
        if not 8 <= source.frames / sample_rate <= 600:
            print("null")
            return
        # Audio2Beats uses the channel mean. Stream downmixing avoids holding
        # the full stereo decode plus an equally long mono copy.
        audio = np.empty(source.frames, dtype=np.float32)
        count = 0
        peak = 0.
        for block in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
            mono = block.mean(axis=1)
            audio[count:count + len(mono)] = mono
            peak = max(peak, float(np.max(np.abs(mono), initial=0.)))
            count += len(mono)
    if not count or peak < .015:
        print("null")
        return
    # Passing an existing, verified checkpoint path keeps inference offline.
    beats, _ = Audio2Beats(str(checkpoint), device="cpu")(audio[:count], sample_rate)
    print(json.dumps({"beats": [round(float(beat), 4) for beat in beats]}, allow_nan=False))


if __name__ == "__main__":
    main()
