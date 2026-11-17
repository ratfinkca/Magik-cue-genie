from __future__ import annotations

import argparse
import math
from pathlib import Path
import struct
import wave


FRAME_RATE = 44_100
MAX_INT16 = 32767


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate synthetic WAV files for Magik-cue-genie demos.")
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="demo-audio",
        help="Directory to write demo WAV files into. Defaults to demo-audio.",
    )
    args = parser.parse_args(argv)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    demo_files = {
        "silence_then_tone.wav": [
            ("silence", 0.5, 0.0),
            ("tone", 2.0, 0.45),
        ],
        "steady_tone_with_trailing_silence.wav": [
            ("tone", 2.0, 0.45),
            ("silence", 0.75, 0.0),
        ],
        "energy_rise_and_drop.wav": [
            ("silence", 0.5, 0.0),
            ("tone", 2.0, 0.15),
            ("tone", 2.0, 0.55),
            ("tone", 2.0, 0.18),
            ("silence", 0.75, 0.0),
        ],
        "silence_only.wav": [
            ("silence", 2.0, 0.0),
        ],
    }

    for filename, segments in demo_files.items():
        _write_segmented_wav(output_dir / filename, segments)

    for filename in demo_files:
        print(output_dir / filename)

    return 0


def _write_segmented_wav(path: Path, segments: list[tuple[str, float, float]]) -> None:
    frames = bytearray()
    for kind, duration_seconds, amplitude in segments:
        frame_count = int(FRAME_RATE * duration_seconds)
        for frame_index in range(frame_count):
            if kind == "tone":
                sample = int(MAX_INT16 * amplitude * math.sin(2 * math.pi * 440 * frame_index / FRAME_RATE))
            else:
                sample = 0
            frames.extend(struct.pack("<h", sample))

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(FRAME_RATE)
        wav_file.writeframes(bytes(frames))


if __name__ == "__main__":
    raise SystemExit(main())
