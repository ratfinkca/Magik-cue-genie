import math
import struct
import wave


def write_silent_wav(path, channels=1, duration_seconds=0.1, frame_rate=44_100):
    frame_count = int(frame_rate * duration_seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(frame_rate)
        wav.writeframes(b"\x00\x00" * frame_count * channels)


def write_tone_wav(path, channels=1, amplitude=0.5, duration_seconds=0.5, frame_rate=44_100):
    frame_count = int(frame_rate * duration_seconds)
    frames = bytearray()
    for frame_index in range(frame_count):
        sample = int(32767 * amplitude * math.sin(2 * math.pi * 440 * frame_index / frame_rate))
        for _ in range(channels):
            frames.extend(struct.pack("<h", sample))

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(frame_rate)
        wav.writeframes(bytes(frames))


def write_silence_then_tone_wav(
    path,
    silence_seconds=0.5,
    tone_seconds=0.5,
    channels=1,
    amplitude=0.5,
    frame_rate=44_100,
):
    silence_frame_count = int(frame_rate * silence_seconds)
    tone_frame_count = int(frame_rate * tone_seconds)
    frames = bytearray(b"\x00\x00" * silence_frame_count * channels)
    for frame_index in range(tone_frame_count):
        sample = int(32767 * amplitude * math.sin(2 * math.pi * 440 * frame_index / frame_rate))
        for _ in range(channels):
            frames.extend(struct.pack("<h", sample))

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(frame_rate)
        wav.writeframes(bytes(frames))


def write_segmented_wav(path, segments, channels=1, frame_rate=44_100):
    frames = bytearray()
    for kind, duration_seconds, amplitude in segments:
        frame_count = int(frame_rate * duration_seconds)
        for frame_index in range(frame_count):
            if kind == "tone":
                sample = int(32767 * amplitude * math.sin(2 * math.pi * 440 * frame_index / frame_rate))
            else:
                sample = 0
            for _ in range(channels):
                frames.extend(struct.pack("<h", sample))

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(frame_rate)
        wav.writeframes(bytes(frames))


def write_pulse_wav(
    path,
    bpm=120,
    beat_count=16,
    pulse_seconds=0.1,
    amplitude=0.8,
    channels=1,
    frame_rate=44_100,
):
    beat_seconds = 60 / bpm
    frame_count = int(frame_rate * beat_seconds * beat_count)
    pulse_frames = max(1, int(frame_rate * pulse_seconds))
    beat_frames = max(1, int(frame_rate * beat_seconds))
    frames = bytearray()
    for frame_index in range(frame_count):
        beat_position = frame_index % beat_frames
        if beat_position < pulse_frames:
            sample = int(32767 * amplitude * math.sin(2 * math.pi * 440 * frame_index / frame_rate))
        else:
            sample = 0
        for _ in range(channels):
            frames.extend(struct.pack("<h", sample))

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(frame_rate)
        wav.writeframes(bytes(frames))
