# Magik Cue Genie

Magik Cue Genie is a local-first DJ preparation and transition practice tool. Cue Studio combines a two-deck mixer, waveform and cue editing, and a reusable Library. The Python CLI generates cue suggestions, JSON sidecars, and reports for local audio. Source audio and DJ application databases stay untouched.

## Try Cue Studio

[Open Cue Studio on GitHub Pages](https://ratfinkca.github.io/Magik-cue-genie/)

The hosted preview is static. Load the synthetic demo pair with the sparkle beside **Deck controls**, or select audio from your device to practice a transition. Playback, cue and loop editing, the Library, and backup import and export run in the browser. Browser support determines whether USB MIDI, writable-folder export, and app installation are available.

Run Studio locally to analyze new tracks, generate automatic cue suggestions, or separate and restore stems. Local analysis uses the Python bridge on the same loopback address as Studio. Browser data is tied to its origin and profile, so the Pages preview and a local address have separate libraries. Use a Studio JSON backup to move preparation between them, then re-add the original audio.

### Run locally

Use Node.js 22.12+ with npm and Python 3.11+. FFmpeg is optional for decoding formats beyond PCM WAV in the Python bridge. Run this from the repository checkout:

```sh
cd studio
npm ci
npm run dev
```

Open the loopback URL printed by Vite. Open a track on either deck or load one from **Library**, then choose **Cue points → Analyze**. Set `MAGIK_PYTHON` to your Python executable or `MAGIK_FFMPEG` to your FFmpeg executable if Studio cannot find them. The basic Studio analyzer loads the Python source from the checkout. Install the editable Python package separately if you want the CLI command.

### Install as an app

From `studio/`, build and launch the production preview on a fixed local port:

```sh
npm run build
npm run preview -- --port 4175 --strictPort
```

Open `http://127.0.0.1:4175/` and let it cache its app files. Use **Install Studio** when offered, or the browser's install command. After the first successful load, supported browsers can open the cached app and play audio from disk or their local Library without a live preview server. Start the preview again for new analysis and local stems. Installation and data remain tied to the address and browser profile used for setup.

## Documentation

- [Cue Studio guide](docs/cue-studio.md) covers decks, beatgrids, loops, USB MIDI, local analysis, and Library workflows.
- [Optional local vocal analysis](docs/studio-vocals.md) covers setup and the model's review limits.
- [Sidecar compatibility](docs/schema-versioning.md) and [output examples](docs/output-examples.md) describe the CLI data formats.
- [CLI MVP specification](SPEC.md) and the [research roadmap](docs/research/2026-11-16-landscape-and-roadmap.md) describe the original goals and architectural decisions.
- [Playlist and hardware research](docs/research/2026-11-16-prepared-playlists-hardware-export.md) discusses vendor handoffs and format limits.

## Python CLI

The CLI analyzes uncompressed 16-bit PCM mono or stereo WAV. With FFmpeg available, it also decodes MP3, M4A, FLAC, AIFF, and AIF through a temporary WAV. The CLI emits reviewable intro, outro, and RMS energy-shift suggestions, with provisional BPM where the onset evidence supports it. Studio's beatgrid and manual cue preparation are a separate workflow.

Each run writes per-track version 1 JSON sidecars and aggregate `report.html` and `report.json`. Reports identify skipped files and decode limitations. The CLI records reasons and confidence with each suggestion and keeps source files read-only. Use a new output directory when rerunning analysis to preserve existing sidecars.

Install the package in editable mode:

```powershell
python -m pip install -e ".[dev]"
```

Analyze one file or a directory:

```powershell
magik-cue-genie analyze .\music --output .\cue-output
```

Choose a named cue heuristic profile:

```powershell
magik-cue-genie analyze .\music --output .\cue-output --profile sensitive
```

Available profiles are `balanced` (default), `conservative`, and `sensitive`. `balanced` uses the default analysis settings. `conservative` requires stronger or more sustained energy before emitting cues and caps energy-shift cues lower. `sensitive` uses a lower energy threshold and fewer sustained windows, so it is more willing to emit heuristic cues. The selected profile is recorded as `analysis_profile` in `report.json`, and the effective numeric settings, including `max_energy_shift_cues`, are recorded as `analysis_settings`.

For manual QA, you can add reference facts to `report.html` and `report.json` without changing analysis or sidecars:

```powershell
magik-cue-genie analyze .\music --output .\cue-output --reference-csv .\reference.csv
```

The reference CSV columns are `source_file`, `reference_bpm`, `reference_key`, and `notes`. Rows match analyzed tracks by source-file basename, case-insensitive.

### Synthetic demo

Generate synthetic WAV files for reproducible local demos:

```powershell
python .\scripts\make_demo_audio.py
```

Analyze the generated files:

```powershell
magik-cue-genie analyze .\demo-audio --output .\cue-output
```

Open `.\cue-output\report.html` in a browser to review the intro, outro, energy-shift, and silence-only examples. The generated `demo-audio` directory is ignored by git.

### Review cue quality

Open `report.html` from the output directory and use the Review / Reference area plus the Review column for each cue. Ratings can be blank, `good`, `early`, `late`, `wrong`, or `maybe`; optional notes can be added beside each rating. Use **Download review feedback** to export a browser-generated JSON feedback file. The export does not modify source audio, sidecar JSON, or `report.json`.

Summarize a downloaded review feedback file:

```powershell
python .\scripts\summarize_review_feedback.py .\magik-cue-genie-review-feedback.json
```

Review workflow:

1. Generate a report with `magik-cue-genie analyze`.
2. Review cues in `report.html`.
3. Download `magik-cue-genie-review-feedback.json`.
4. Run the summary script above.
5. Optionally rerun the report with previous feedback for a read-only comparison overlay:

```powershell
magik-cue-genie analyze .\demo-audio --output .\cue-output\review --profile balanced --feedback-json .\magik-cue-genie-review-feedback.json
```

When previous feedback includes reference BPM/key/source values, `report.html` also shows a diagnostic detected-vs-reference comparison and flags possible half-time or double-time BPM estimates. This is for review only and does not affect analysis or cue placement.

Use the feedback overlay to compare CLI energy-envelope suggestions against your listening notes.

## Development and tests

Run the Python suite from the checkout after installing the development dependencies:

```powershell
python -m pytest
```

On Windows, if pytest temp files need to stay inside the project folder:

```powershell
$env:TMP = "$PWD\.tmp"; $env:TEMP = "$PWD\.tmp"; python -m pytest --basetemp .\.tmp\pytest
```

Or run the helper script:

```powershell
.\scripts\test.ps1
```

The Studio tests cover the browser modules and the local analyzer bridge with generated audio. From the checkout:

```sh
cd studio
npm ci
node --test
npm run build
```

The Python package lives in `src/magik_cue_genie/`. The React/Vite app is in `studio/src/`, and its loopback analyzer middleware is in `studio/server/`.

The Pages workflow tests and builds Studio on pull requests and deploys the static build from `main`. To enable it in a fork, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. [Cue Studio Pages workflow](.github/workflows/studio-pages.yml) · [GitHub Pages publishing setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Safety principles

- Treat source audio as read-only.
- Write only to explicit output paths or clearly named sidecar files.
- Never write to DJ software databases as part of this workflow.
- Keep generated suggestions explainable and easy to review.
- Prefer small, reviewable changes over broad rewrites.
