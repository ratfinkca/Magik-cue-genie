from pathlib import Path
import importlib.util
import wave

from magik_cue_genie.analysis import analyze_audio


def test_make_demo_audio_creates_valid_wav_files(tmp_path):
    module = _load_demo_audio_script()

    assert module.main([str(tmp_path)]) == 0

    expected_files = {
        "silence_then_tone.wav",
        "steady_tone_with_trailing_silence.wav",
        "energy_rise_and_drop.wav",
        "silence_only.wav",
    }
    assert {path.name for path in tmp_path.glob("*.wav")} == expected_files

    for filename in expected_files:
        with wave.open(str(tmp_path / filename), "rb") as wav_file:
            assert wav_file.getnchannels() == 1
            assert wav_file.getsampwidth() == 2
            assert wav_file.getframerate() == 44_100
            assert wav_file.getnframes() > 0


def test_demo_energy_rise_and_drop_produces_energy_shift_cue(tmp_path):
    module = _load_demo_audio_script()

    assert module.main([str(tmp_path)]) == 0

    result = analyze_audio(tmp_path / "energy_rise_and_drop.wav")

    assert result.sidecar is not None
    cue_labels = [cue.label for cue in result.sidecar.cues]
    assert "intro" in cue_labels
    assert "outro" in cue_labels
    assert "energy_shift" in cue_labels


def _load_demo_audio_script():
    script_path = Path(__file__).parents[1] / "scripts" / "make_demo_audio.py"
    spec = importlib.util.spec_from_file_location("make_demo_audio", script_path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module
