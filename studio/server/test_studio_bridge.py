"""Synthetic adapter checks; FFmpeg is mocked unless explicitly usable."""
from pathlib import Path
import struct
import wave

import pytest

import magik_cue_genie.studio_bridge as bridge


def write_wav(path, width=2, float_format=False):
    frames = 8_000
    if float_format:
        payload = struct.pack("<f", 0.1) * frames
        header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(payload), b"WAVE", b"fmt ",
                             16, 3, 1, 8_000, 32_000, 4, 32, b"data", len(payload))
        path.write_bytes(header + payload)
    else:
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(width)
            audio.setframerate(8_000)
            audio.writeframes(bytes(frames * width))


@pytest.mark.parametrize("width,float_format", [(3, False), (4, False), (4, True)])
def test_wide_and_float_wav_use_bounded_optional_conversion(tmp_path, monkeypatch, width, float_format):
    source = tmp_path / "uploaded.wav"
    write_wav(source, width=width, float_format=float_format)
    original = source.read_bytes()
    unrelated = tmp_path / "decoded.wav"
    unrelated.write_bytes(b"never remove an existing neighboring file")
    calls = []

    def decode(command, **kwargs):
        calls.append((command, kwargs))
        write_wav(Path(command[-1]))

    monkeypatch.setattr(bridge.subprocess, "run", decode)
    result = bridge.analyze_uploaded_copy(source, "uploaded.wav")

    assert result["sidecar"]["analysis"]["duration_seconds"] == 1.0
    assert result["sidecar"]["analysis"]["studio_beatgrid"]["status"] == "unavailable"
    assert result["sidecar"]["warnings"]
    command, options = calls[0]
    assert command[command.index("-f") + 1] == "wav"
    assert command[command.index("-protocol_whitelist") + 1] == "file,pipe"
    assert "-fs" in command and "-t" in command and "-n" in command
    assert options["timeout"] == 60
    assert source.read_bytes() == original
    assert unrelated.read_bytes() == b"never remove an existing neighboring file"
    assert not Path(command[-1]).parent.exists()


def test_standard_pcm_wav_does_not_require_ffmpeg(tmp_path, monkeypatch):
    source = tmp_path / "uploaded.wav"
    write_wav(source)
    monkeypatch.setattr(bridge.subprocess, "run", lambda *a, **k: pytest.fail("16-bit PCM needs no FFmpeg"))
    assert bridge.analyze_uploaded_copy(source, "uploaded.wav")["sidecar"]["analysis"]["duration_seconds"] == 1.0


def test_studio_does_not_run_the_cli_cue_stage(tmp_path, monkeypatch):
    import magik_cue_genie.analysis as base

    source = tmp_path / "uploaded.wav"
    write_wav(source)
    monkeypatch.setattr(base, "_suggest_cues", lambda *args: pytest.fail("Studio uses its own cue evidence"))
    result = bridge.analyze_uploaded_copy(source, "uploaded.wav")["sidecar"]
    assert result["analysis"]["studio_base"]["status"] == "ready"
    assert result["analysis"]["energy_summary"] is not None


def test_base_and_vocal_failure_keep_rhythm_and_vocal_free_cues(tmp_path, monkeypatch):
    source = tmp_path / "uploaded.wav"
    write_wav(source)

    def fail(*args, **kwargs):
        raise RuntimeError("private failure detail")

    def rhythm(_path):
        return {
            "tempo": {"bpm": 120, "source": "synthetic", "confidence": .8, "status": "estimated"},
            "grid": {"status": "estimated", "beat_times_seconds": [.1, .6]},
            "cues": [{"label": "first_pulse", "time_seconds": .1, "reason": "Supported beat", "confidence": .6}],
            "cue_status": "ready", "warnings": [],
        }

    monkeypatch.setattr(bridge, "analyze_audio", fail)
    monkeypatch.setattr(bridge, "analyze_studio_rhythm", rhythm)
    monkeypatch.setattr(bridge, "beat_this_prediction", lambda *args: pytest.fail("an observed grid should skip Beat This"))
    monkeypatch.setattr(bridge, "detect_vocal_loops", fail)
    result = bridge.analyze_uploaded_copy(source, "uploaded.wav")["sidecar"]
    assert result["analysis"]["duration_seconds"] == 1
    assert result["analysis"]["studio_base"]["status"] == "error"
    assert result["analysis"]["studio_beatgrid"]["beat_times_seconds"] == [.1, .6]
    assert result["analysis"]["studio_cues"]["status"] == "partial"
    assert result["analysis"]["studio_vocals"]["status"] == "error"
    assert [cue["label"] for cue in result["cues"]] == ["First pulse"]
    assert "private failure detail" not in str(result)


def test_rhythm_failure_keeps_base_data_and_unarmed_vocal_loop(tmp_path, monkeypatch):
    source = tmp_path / "uploaded.wav"
    write_wav(source)

    def fail(_path):
        raise RuntimeError("failed scan")

    monkeypatch.setattr(bridge, "analyze_studio_rhythm", fail)
    monkeypatch.setattr(bridge, "detect_vocal_loops", lambda path, bpm: {
        "status": "ready", "message": "Synthetic classifier adapter test",
        "candidates": [{"start_seconds": .2, "end_seconds": .8, "confidence": .8, "source": "synthetic"}],
    })
    result = bridge.analyze_uploaded_copy(source, "uploaded.wav")["sidecar"]
    assert result["analysis"]["studio_base"]["status"] == "ready"
    assert result["analysis"]["energy_summary"] is not None
    assert result["analysis"]["studio_beatgrid"]["status"] == "error"
    assert result["analysis"]["studio_beatgrid"]["beat_times_seconds"] == []
    assert result["analysis"]["estimated_bpm"] is None
    assert result["analysis"]["studio_cues"]["status"] == "partial"
    assert not result["cues"][0]["metadata"]["loop"]["active"]


def test_full_mix_vocal_suggestions_are_unarmed_even_without_grid(tmp_path, monkeypatch):
    source = tmp_path / "uploaded.wav"
    write_wav(source)
    monkeypatch.setattr(bridge, "detect_vocal_loops", lambda path, bpm: {
        "status": "ready", "message": "Synthetic classifier adapter test",
        "candidates": [{"start_seconds": 0.2, "end_seconds": 0.8, "confidence": 0.8,
                        "source": "synthetic", "armed": True}],
    })
    result = bridge.analyze_uploaded_copy(source, "uploaded.wav")["sidecar"]
    assert result["analysis"]["studio_beatgrid"]["beat_times_seconds"] == []
    assert result["cues"][0]["metadata"]["loop"] == {"kind": "vocal", "end_seconds": 0.8, "active": False}
    assert not result["cues"][0]["metadata"]["beat_aligned"]


def test_model_beats_are_display_only_and_keep_grid_abstention(tmp_path, monkeypatch):
    source = tmp_path / "uploaded.wav"
    write_wav(source)
    prediction = {"status": "predicted", "source": "beat_this_small0", "bpm": 120,
                  "beat_times_seconds": [.05, .55], "downbeat_verified": False}
    monkeypatch.setattr(bridge, "beat_this_prediction", lambda *args: prediction, raising=False)
    monkeypatch.setattr(bridge, "detect_vocal_loops", lambda path, bpm: {"status": "unavailable"})
    result = bridge.analyze_uploaded_copy(source, "uploaded.wav")["sidecar"]
    analysis = result["analysis"]
    assert analysis["studio_model_grid"] == prediction
    assert analysis["studio_beatgrid"]["status"] == "unavailable"
    assert not analysis["studio_beatgrid"]["beat_times_seconds"]
    assert analysis["estimated_bpm"] == 120
    assert analysis["estimated_bpm_source"] == "beat_this_small0"
    assert result["cues"] == []


def test_inaccessible_ffmpeg_has_actionable_error_and_cleans_temporary_decode(tmp_path, monkeypatch):
    source = tmp_path / "uploaded.wav"
    write_wav(source, width=3)

    def cannot_start(*args, **kwargs):
        raise OSError(22, "inaccessible executable")

    monkeypatch.setattr(bridge.subprocess, "run", cannot_start)
    with pytest.raises(bridge.AnalysisInputError, match="FFmpeg could not start"):
        bridge.analyze_uploaded_copy(source, "uploaded.wav")
    assert list(tmp_path.iterdir()) == [source]


@pytest.mark.parametrize("name", ["../source.wav", "C:\\source.wav", "source.ogg"])
def test_rejects_paths_and_unsupported_extensions(tmp_path, name):
    source = tmp_path / "uploaded.wav"
    write_wav(source)
    with pytest.raises(bridge.AnalysisInputError):
        bridge.analyze_uploaded_copy(source, name)
