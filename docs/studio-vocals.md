# Automatic local vocal phrase proposals

Studio can scan the **original mixed track** with Google's YAMNet classifier.
No stem preparation is needed. It scores singing, choir, chant, rap and humming
classes; full-mix loudness is not treated as evidence of vocals. It does not
separate stems or transcribe lyrics. Playback remains the original mix.

## One-time setup

From the repository, using the same Python 3.11+ interpreter as Studio:

```powershell
python scripts/setup_studio_vocals.py
```

This explicit setup fetches Google's official 16,061,524-byte TFLite model and
`ai-edge-litert==2.3.0` plus NumPy and dependencies (roughly 35 MB of package
downloads on Windows x64). It writes only to the ignored `.tmp/vocal-model` and
`.tmp/vocal-runtime` directories. No audio is read or uploaded during setup.
Do not delete those directories if you want offline detection to remain enabled.
Restart Studio after installation. Analysis makes **no network requests** and
does not need FFmpeg for vocal inference on the bridge's decoded PCM WAV.

An administrator can instead set `MAGIK_YAMNET_MODEL` to the identical verified
model and `MAGIK_VOCAL_RUNTIME` to a directory containing the Python packages.
The default paths are resolved from this checkout, independent of the shell's
working directory. Model loading verifies SHA256
`e193da5676a2fdb7a3702c10fba62aa27d76f64e4534467443811c1a2ff1667d`.
No model weights or dependencies are committed to the repository.

## Interpretation and limits

The detector reads windows from the decoded WAV without changing it, downmixes
to mono, low-pass filters when downsampling, and resamples to the required
16 kHz. It uses 975 ms windows at 480 ms intervals. Singing-class evidence must
remain strong across a region; low-activity windows must bound both ends.
Only 2–16 second regions are proposed, up to eight per track. Long continuous
vocals are deliberately not cut into arbitrary lyric fragments. The scan has
a 40-second time budget and supports the bridge's 30-minute track limit; any
partial beginning-only scan is reported explicitly.

Scores are model evidence, **not calibrated probabilities of good loops**.
The model is a general AudioSet classifier, not a specialized DJ phrase model:
instruments can cause false positives and quiet/processed vocals can be missed.
Boundaries have roughly one-second precision. Lower activity around a phrase
does not prove complete words, a smooth audio seam, repetition, or bar alignment.
Proposals remain unarmed; audition the words and seam and adjust to a verified
beat grid before arming. BPM alone never establishes a beat-grid offset.
Unavailable/corrupt models and inference errors leave basic cue analysis intact.

Tests use generated signals and synthetic score fixtures, never downloaded songs.
These verify abstention, bounded results, read-only inference and integration;
they do not measure real-music vocal detection accuracy.

## Model choice and primary sources

- [Google's YAMNet model card](https://www.kaggle.com/models/google/yamnet/tensorFlow2/yamnet/1)
  identifies Apache 2.0 licensing and the audio-event task.
- [Official YAMNet implementation and model documentation](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
  documents 521 classes, the feature pipeline, window timing and model limitations.
- [Google LiteRT](https://developers.google.com/edge/litert)
  supplies the local Windows Python runtime; inference uses its CPU interpreter.
- [Meta's Demucs repository](https://github.com/facebookresearch/demucs)
  was considered for separation but is a substantially heavier pipeline. We use
  the small classifier to find reviewable phrases without requiring stems.

YAMNet code and the Google model card identify Apache 2.0. Keep the upstream
license/model provenance when redistributing dependencies or weights; the setup
records a local provenance JSON. This project does not redistribute training
audio or claim rights in any user's source recording.
