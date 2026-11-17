"""Explicit one-time network setup; Studio analysis itself never downloads files.

Run from the project checkout with the same Python used by the Studio bridge.
Downloads Google's official 16 MB YAMNet weights and a compact local CPU runtime
to ignored .tmp directories. Does not read or upload any audio.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from magik_cue_genie.studio_vocals import MODEL_SHA256, MODEL_URL


def main() -> int:
    model_dir = ROOT / ".tmp/vocal-model"
    runtime = ROOT / ".tmp/vocal-runtime"
    model_dir.mkdir(parents=True, exist_ok=True)
    target = model_dir / "yamnet.tflite"
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != MODEL_SHA256:
            raise SystemExit("Existing model failed integrity verification; move it aside before rerunning setup.")
    else:
        print("Downloading official Google YAMNet weights (16 MB); no audio is uploaded.", flush=True)
        with urllib.request.urlopen(MODEL_URL, timeout=60) as response:
            data = response.read(20 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != MODEL_SHA256:
            raise SystemExit("Downloaded model did not match the pinned SHA256; nothing installed.")
        with target.open("xb") as output:
            output.write(data)
    if not (runtime / "ai_edge_litert/interpreter.py").is_file():
        subprocess.run([
            sys.executable, "-m", "pip", "install", "--target", str(runtime),
            "ai-edge-litert==2.3.0", "numpy>=2,<3", "--disable-pip-version-check",
        ], check=True)
    manifest = {
        "model": "Google YAMNet", "url": MODEL_URL, "sha256": MODEL_SHA256,
        "model_card": "https://www.kaggle.com/models/google/yamnet/tensorFlow2/yamnet/1",
        "license": "Apache-2.0 (Google model card)",
        "runtime": "ai-edge-litert==2.3.0", "inference": "local CPU only",
    }
    (model_dir / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Local vocal model installed. Restart Studio, then analyze the original mixed track.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
