import json

from magik_cue_genie.models import TrackSidecar
from magik_cue_genie.sidecar import sidecar_path_for, write_sidecar


def test_json_sidecar_shape_matches_spec(tmp_path):
    audio_path = tmp_path / "example.wav"
    audio_path.write_bytes(b"fake wav placeholder")

    sidecar = TrackSidecar.placeholder_for(audio_path)
    sidecar_path = sidecar_path_for(audio_path, tmp_path / "out")
    write_sidecar(sidecar, sidecar_path)

    data = json.loads(sidecar_path.read_text(encoding="utf-8"))
    assert data == {
        "schema_version": 1,
        "source_file": "example.wav",
        "analysis": {
            "duration_seconds": None,
            "estimated_bpm": None,
            "estimated_bpm_confidence": None,
            "estimated_bpm_source": None,
            "bpm_debug": None,
            "estimated_key": None,
            "energy_summary": None,
        },
        "cues": [],
        "warnings": [],
    }
