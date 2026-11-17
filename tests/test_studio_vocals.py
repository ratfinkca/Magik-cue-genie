"""Synthetic score fixtures test selection, not singing-recognition accuracy."""
import math
import hashlib
import socket
import struct
import wave

import pytest

from magik_cue_genie.studio_vocals import detect_vocal_loops, select_vocal_candidates, vocal_model_status


def test_no_model_reports_unavailable_without_audio_or_download(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGIK_YAMNET_MODEL", str(tmp_path / "missing.tflite"))
    assert vocal_model_status()["status"] == "unavailable"


def test_instrumental_scores_abstain():
    assert select_vocal_candidates([0.02] * 80, .48, 38.4) == []


def test_vocal_activity_suggests_unarmed_bounded_review():
    scores = [0.01] * 8 + [0.85] * 12 + [0.01] * 10
    loops = select_vocal_candidates(scores, .48, 14.4)
    assert len(loops) == 1
    loop = loops[0]
    assert 0 <= loop["start_seconds"] < loop["end_seconds"] <= 14.4
    assert loop["armed"] is False and loop["beat_aligned"] is False
    assert 0 < loop["confidence"] < 1
    assert loop["reasons"]


def test_short_isolated_peak_and_nonfinite_scores_abstain():
    assert select_vocal_candidates([0, 0.99, 0, 0, 0], .48, 2.4) == []
    assert select_vocal_candidates([math.nan] * 20, .48, 9.6) == []


def test_long_vocal_passage_not_arbitrarily_cut_into_lyrics():
    assert select_vocal_candidates([.95] * 100, .48, 48) == []


def test_partial_ending_does_not_create_false_closed_phrase():
    assert select_vocal_candidates([0] * 5 + [.95] * 10, .48, 60) == []


def test_corrupt_model_abstains_without_reading_audio(tmp_path, monkeypatch):
    model = tmp_path / "bad.tflite"
    model.write_bytes(b"bad")
    runtime = tmp_path / "runtime/ai_edge_litert"
    runtime.mkdir(parents=True)
    (runtime / "interpreter.py").write_text("")
    monkeypatch.setenv("MAGIK_YAMNET_MODEL", str(model))
    monkeypatch.setenv("MAGIK_VOCAL_RUNTIME", str(runtime.parent))
    result = detect_vocal_loops(tmp_path / "not-read.wav")
    assert result["status"] == "error" and result["candidates"] == []
    assert "integrity" in result["message"]


@pytest.mark.parametrize("rate", [12000, 44100])
def test_installed_model_runs_offline_on_synthetic_tone_readonly(tmp_path, monkeypatch, rate):
    if vocal_model_status()["status"] != "ready":
        pytest.skip("Optional local YAMNet setup is not installed")
    audio = tmp_path / "synthetic.wav"
    data = b"".join(struct.pack("<h", int(5000 * math.sin(2 * math.pi * 440 * i / rate)))
                    for i in range(rate * 4))
    with wave.open(str(audio), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(data)
    digest = hashlib.sha256(audio.read_bytes()).digest()
    def deny_network(*args, **kwargs):
        raise AssertionError("Inference must stay offline")
    monkeypatch.setattr(socket, "socket", deny_network)
    result = detect_vocal_loops(audio)
    assert result["status"] == "ready", result
    assert result["candidates"] == []
    assert result["partial"] is False
    assert result["analyzed_seconds"] == 4
    assert hashlib.sha256(audio.read_bytes()).digest() == digest
