**Magik-cue-genie research and proposed roadmap**

Research date: 16 November 2026. Repository baseline: commit 0c2e0de. Status: proposed direction for discussion; this document does not replace SPEC.md or AGENTS.md.

Magik-cue-genie's strongest next experiment is a local cue preparation and review workbench: help a DJ hear why a cue was suggested, correct it quickly, and retain that judgment across future analyses. Automatic cue generation alone is already a crowded product category. The advantage to pursue is measurable preparation quality for a specific audience, with understandable evidence and a verifiable promise that original music and DJ libraries remain untouched.

Keep the Python core and existing review work. Repair timing and output identity first; compare established beat-analysis backends; make auditioning and correction the main interface. Add stem analysis only when it demonstrably improves a DJ decision. Treat cloud execution, vendor interchange and a desktop wrapper as separate extensions with explicit entry criteria.

The research covers the tracked repository, prior implementation and QA notes, official product documentation, upstream repositories, model cards and research papers. Product features below come from published documentation. Suggested audience, architecture and success thresholds are proposals.

**The current project is an analysis experiment with a substantial review report.** It is beyond a placeholder scaffold, but it is not yet a musically validated cue generator.

| Area | Present capability | Important boundary |
| --- | --- | --- |
| CLI | Python 3.11+, Typer; file or directory; explicit output; balanced/conservative/sensitive profiles | Directory discovery is non-recursive |
| Audio | Duration and RMS energy for 16-bit PCM WAV; optional temporary ffmpeg decoding for MP3, M4A, FLAC, AIFF/AIF | Unsupported WAV encodings are not normalized through ffmpeg; unavailable decoders can produce placeholders |
| Cues | Intro, outro and generic energy shifts, with reasons and fixed conservative scores | No actual vocal, breakdown, build, drop, phrase, downbeat or key detection |
| Tempo | RMS onset-interval estimate plus ranked diagnostic candidates | Coarse timing and consistency scores do not establish correct musical tempo |
| Outputs | Per-track JSON, aggregate JSON, static HTML with SVG timelines | Existing sidecars are refused; reports can overwrite; reruns and collisions need a policy |
| Human review | Ratings, notes, reference fields, feedback JSON download/import overlay, summary script | No audio audition, cue correction, autosave or stable identity across changed timestamps |
| Safety | Normal analysis reads audio; temporary decoding; no DJ-database code | Batch output is not transactional; stronger collision and failure handling is needed |

The earlier chat deliberately froze generated cue timestamps while building reporting and diagnostic visibility. That was a useful experimental boundary. Its repeated examples of wrong/unknown BPM and overly early outros now support changing the next milestone from more diagnostics to trustworthy timing and evaluation. Named tracks in the chat are context, not redistributed test fixtures or ground-truth labels.

**The audit found three timing issues that should precede model or interface expansion.**

1. The energy summary shrinks long tracks to at most 200 buckets but retains the original 0.25-second window duration. Intro and energy-shift detectors then interpret compressed bucket indices as original analysis-window indices. This begins above 50 seconds at the default settings. An in-memory 100-second energy sequence with transitions at 20 and 50 seconds produced intro at 10 seconds and energy shift at 25 seconds. Outro has separate approximate compensation. See [analysis.py](../../src/magik_cue_genie/analysis.py), especially lines 285–315, 877–914 and 1021. Analysis features need explicit timing independent of display compression.
2. Tempo estimation uses 0.25-second RMS windows. A synthetic 30-second pulse sweep produced 100→120, 110→120, 128→120 and 140→96 BPM, sometimes with substantial reported confidence. A 120 BPM fixture works well, but that does not establish broad tempo accuracy. See analysis.py lines 256, 449, 730 and 838. The score measures aspects of interval consistency; it is not a probability of correctness.
3. The report's hypothetical grid starts at audio time zero and groups four evenly spaced beats. BPM alone does not establish beat phase, downbeat, meter or phrase position. The report can also use a rejected top tempo candidate; an input with confidence 0.01 still generated an alignment suggestion. Actual sidecars remain unchanged. See [report.py](../../src/magik_cue_genie/report.py), lines 120–212. Until validated, these are alignment hypotheses, not proven improvements.

The pulse probe used generated 8 kHz, 16-bit mono signals with 100 ms, 440 Hz pulses at amplitude 0.8. Results were 90→80, 100→120, 110→120, 120→120, 128→120, 130→120, 140→96, 150→unknown, 160→80 and 174→unknown. Some half/double-tempo answers are musically ambiguous; the non-octave errors still show a clear resolution problem. These probes expose failure modes; they do not estimate accuracy on music.

Other foundation work is concrete. Same-stem files such as song.wav and song.mp3 collide on one sidecar name. References and feedback are keyed by lowercased basename; duplicate entries overwrite one another. Cue feedback matches label plus a 10 ms timestamp tolerance, so correcting an algorithm's timing can detach prior feedback. A collision midway through a batch leaves partial output. ffmpeg has no timeout. The feedback summarizer counts blank ratings as reviewed and omits some no-cue feedback. Relevant files are [sidecar.py](../../src/magik_cue_genie/sidecar.py), [feedback.py](../../src/magik_cue_genie/feedback.py), [reference.py](../../src/magik_cue_genie/reference.py), [cli.py](../../src/magik_cue_genie/cli.py) and [summarize_review_feedback.py](../../scripts/summarize_review_feedback.py).

The architecture is worth retaining. CLI parsing, data models, sidecar writing and report rendering are already separated. Frozen dataclasses, explicit profiles, escaped HTML, synthetic fixtures, warnings and schema compatibility rules are good foundations. Refactor only around real boundaries: analysis.py is 1,076 lines and report.py is 1,723 lines; decoding, signal features, diagnostic logic and UI rendering should not keep accumulating in those two files.

Verification on this research date: 119 test functions exist across eight modules. Both available Python interpreters lack pytest and Typer, so the full pytest suite could not run without installing dependencies. Direct invocation of 49 existing fixture-free report/feedback/summary tests passed. The earlier chat reports 119 passing tests at its last implementation turn; that is historical evidence, not a fresh full-suite result. There are no browser-executed review tests or broad tempo/phase benchmarks yet.

**The competitive landscape already includes personalized cues, local AI and review interfaces.** The implication is to test a focused benefit, not to assume an empty market.

| Product or project | Documented capability relevant to Magik | What it changes about our direction |
| --- | --- | --- |
| rekordbox 7 | Intelligent Cue Creation learns preferred Hot Cue/Memory Cue positions; vocal-position display and integrated preparation tools | Personalized cue placement is established. [Official overview](https://rekordbox.com/en/feature/overview/) |
| Mixed In Key 11 / Pro | Editable automatic cues with key/BPM/energy; Pro adds transition/mashup audition and stems | Human review after automation is already part of the offering. [Cue guidance](https://mixedinkey.com/wiki/how-cue-points-can-improve-your-djing/), [Pro workflow](https://mixedinkey.com/workflows/what-is-mixed-in-key-11-pro/) |
| Lexicon | ML drop/breakdown/fade-out detection; customizable cue templates, names, colors and offsets; manual anchors | Configurable cue layouts are a mature competitor. Its manual acknowledges genre/grid sensitivity. [Cue generator](https://www.lexicondj.com/manual/cue-point-generator) |
| DJ.Studio 5.0 | Released 11 November 2026; editable phrase detection, Smart Beatgrid, phrase-aligned transitions and exports to six DJ apps | Phrase visualization and cross-app preparation are expanding quickly. [Release](https://dj.studio/djstudio50), [export workflow](https://help.dj.studio/en/articles/16833153-export-dj-set-to-your-live-dj-software) |
| Engine DJ | Current download page lists 5.3.0, 5 November 2026; cue/grid/loop editing and library import workflows; pre-rendered stems for supported hardware | Potential complementary audience, but sidecars alone do not put cues on a player. [Downloads](https://enginedj.com/downloads), [stems](https://enginedj.com/stems) |
| Serato DJ | Current announcement describes 5.0 release and Lucid Beatgrids; saved Cue Loops | Beat tracking is an improving incumbent capability. Structural cue generation was not established from inspected Serato DJ sources. [Announcement](https://the-drop.serato.com/announcements/lucid-beatgrids-just-dropped-in-the-serato-dj-5-0-beta/), [Cue Loops](https://support.serato.com/hc/en-us/articles/18050017443087-Cue-Loops) |
| Traktor Pro 4 | Flexible beatgrids, cue/loop preparation, four-part stem separation | Complement the existing performance environment. [Official product](https://www.native-instruments.com/products/traktor-pro) |
| VirtualDJ | Automatically analyzed first-beat/Automix points, editable POIs, cues, loops and actions; real-time stems | Mix-in/out automation is not a new category. [POI manual](https://virtualdj.com/manuals/virtualdj/editors/poieditor.html), [stems](https://autoupdate.virtualdj.com/stems/) |
| djay Pro | Windows cue/grid editing and Neural Mix; OneLibrary support on compatible hardware | Portability is improving but remains version/device-specific. [Windows product](https://www.algoriddim.com/djay-pro-windows), [release notes](https://www.algoriddim.com/djay-pro-windows/releasenotes) |
| KimiCue | Windows local drop detection, eight-cue preview, rekordbox XML or Serato-tag output; advertises $29 one-time | Close low-cost competitor. Its Serato write route conflicts with our audio immutability rule. [Official site](https://kimicue.com/) |
| MixGoat | On-device cue model, confidence/sensitivity/spacing controls and review; writes supported libraries/tags | Local processing and confidence controls alone are not differentiation. [Workflow](https://mixgoat.com/guides/automatic-cue-points) |
| CueStem AI | Local folder/USB analysis, grids, cues/loops and uncertainty flags; optional cloud repair/stems | Very close hybrid concept. Advertised quality still needs hands-on evaluation. [Official site](https://cuestem.com/) |
| CueIt | MIT Alpha 2 project with Rust core, desktop/CLI/WASM, waveform editing, batch analysis, persistence and exports | Closest open-source comparison. Current README says neural beat tracking is disabled pending frontend validation and cue heuristics are still being tuned. [Repository](https://github.com/CurePortal/Cueit) |
| TimeCues Studio | MIT annotation/evaluation workspace with waveform labels, detector comparisons and mir_eval | Useful comparison or collaborator if Magik emphasizes evaluation. [Repository](https://github.com/sapirca/timecues-studio), [September 2026 paper](https://arxiv.org/abs/2609.10338) |
| One Tagger / Crate Hackers | Metadata/custom tagging; crate building, duplicates, library chat and music discovery | Expanding into a full library-management suite would multiply competitors and scope. [One Tagger](https://onetagger.github.io/index.html), [Crate Hackers](https://www.cratehackers.com/) |

Watchlist: [DEX 4.1](https://pcdj.com/dex-4-1-dj-software-release/) advertises structure detection and automatic cues. [WayCue](https://waycue.com/) has a cue editor/cloud-library proposition, but its feature page marks several AI/stem/export capabilities coming soon; do not count those as shipped. [BeatCue](https://beatcue.app/) is an adjacent music-retiming tool for video editors rather than verified DJ hot-cue competition.

Several smaller vendors claim rekordbox cannot automatically generate hot cues, contradicting rekordbox's own Intelligent Cue Creation documentation. DJ.Studio's older export information also differs from its recent release documentation. Prefer upstream capabilities and dated release pages over comparative marketing. Availability of a GUI says nothing by itself about keyboard or screen-reader accessibility.

**Three product directions remain plausible.**

| Direction | Audience and value | Cost and constraint | Assessment |
| --- | --- | --- | --- |
| Focused local preparation workbench | Windows DJs with owned local files; review useful mix-in/out and transition cues, understand structure, preserve decisions | Must make review faster and ultimately offer useful transfer; direct competitors exist | Recommended first product hypothesis |
| Analysis and annotation toolkit | Technical DJs, MIR researchers and plugin authors; reproducible sidecars, comparisons and benchmark tooling | Small audience; overlap with TimeCues and CueIt | Keep the core usable this way; consider collaboration |
| Broad AI DJ suite | General DJs; library management, stems, discovery, automatic mixing, device sync and cloud | Multiple large products, operational cost, extensive compatibility and safety burden | Defer; it obscures the first measurable benefit |

Start with an explicit repertoire and convention: a proposed pilot is electronic dance tracks with roughly stable 4/4 timing, preparing mix-in, main-event and mix-out cues. This is a scope choice, not evidence about the user's present repertoire. Later open-format/mobile-DJ support would need separate evaluation for pop, hip-hop, live drums, tempo changes, spoken sections and irregular structures. Do not normalize every genre into one dance-tempo range.

Engine/Mixxx users are plausible early reviewers because an independent second opinion can help. However, if their primary need is immediate hardware-ready transfer, a read-only prototype will not satisfy it. Beginners may value explainable listening exercises; experienced DJs may value fast corrections and consistent cue conventions. Professional gig-ready USB preparation should wait for proven timing and reliable supported interchange.

The concrete promise to test is: “Review and understand suggested cue points on your own tracks, with clear reasons and no changes to your music or DJ library.” Potential strengths are an uncertainty queue, durable human annotations, visible evidence, easy auditioning and reproducible results. Each is a product commitment to validate; none is claimed as a unique invention.

The user's DJ experience is especially valuable as annotation guidance: what makes a usable entrance, how much lead-in is useful, when vocals interfere, and which cue conventions help during a set. Record that as understandable presets and reviewer decisions before trying to train a personalized model. Do not tune the engine to reproduce a handful of named tracks from the old chat.

**Use specialized audio models for timing and structure, and language models for interpretation.** A system that can describe a chorus is not automatically a reliable source of cue timestamps.

| Task | Candidate | Recommendation and constraints |
| --- | --- | --- |
| Basic features and comparison baseline | NumPy/librosa | Use a higher-resolution spectral/onset baseline. librosa's beat tracker returns beat events, not just BPM, and accepts time-varying tempo. It does not establish downbeats by itself. [Official API](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html) |
| Beats and downbeats | Beat This! | First neural candidate to benchmark alongside the baseline. Python/PyTorch, CPU fallback and CUDA; upstream explicitly licenses code and published weights MIT, with a training-data caveat. [Upstream](https://github.com/CPJKU/beat_this) |
| Joint structure analysis | All-In-One / allin1 | Established comparator returning beats/downbeats and functional sections. Windows NATTEN source-build instructions and Demucs/madmom dependencies make it a research worker, not an automatic default install. [Upstream](https://github.com/mir-aidj/all-in-one) |
| Newer section analysis | SongFormer | Strong research comparison. Code states CC BY 4.0; pipeline references MuQ and MusicFM, so audit all weights separately. Published 2–4-second inference is on an NVIDIA L40 and excludes model loading, not a laptop promise. [Upstream](https://github.com/ASLP-lab/SongFormer), [model](https://huggingface.co/ASLP-lab/SongFormer) |
| Audio plus lyrics for sections | SCALE | October 2026 research direction with section boundaries/labels and optional lyric evidence. Linux/CUDA extensions, separate lyric environment and pending SheetSage-MSA data make it exploratory. [Repository](https://github.com/Multimodal-Music-Research-Lab/SCALE), [paper](https://arxiv.org/abs/2610.26253) |
| Stem separation | audio-separator / UVR family | Evaluate one pinned separator/checkpoint. Wrapper supports several architectures including RoFormer families; benchmark precision and hardware settings. MIT wrapper is not a blanket license for every downloadable checkpoint. [Upstream](https://github.com/nomadkaraoke/python-audio-separator) |
| Separation baseline | Demucs | Useful established benchmark; original Meta repository was archived on 1 January 2025. Do not treat the archived repo as the only long-term integration choice. [Repository](https://github.com/facebookresearch/demucs) |
| DSP, tagging, key and descriptors | Essentia | Broad MIR toolkit; library is AGPLv3/proprietary, MTG models are CC BY-NC-SA 4.0/proprietary. Evaluate deployment/licensing before selection. [Library](https://essentia.upf.edu/documentation.html), [models](https://essentia.upf.edu/models.html) |
| Key estimation | Deezer S-KEY | Interesting CPU/GPU comparator, but upstream says MIT code and noncommercial-research-only skey.pt weights. Do not bundle based on another project's “MIT” claim. [Upstream license statement](https://github.com/deezer/skey/blob/main/README.md) |
| Semantic similarity and search | MuQ / MuQ-MuLan | Potential later “find similar instrumental sections” or descriptive search. Code MIT, released weights CC BY-NC 4.0. Not a default dependency for an unrestricted product. [Upstream](https://github.com/tencent-ailab/MuQ) |
| Local musical descriptions/Q&A | MOSS-Music | 2026 music-specialized model for captions, lyrics, structure and musical questions. Model card lists Apache 2.0; 8B-class deployment is a separate resource and reliability experiment. Pin and review required custom inference code. [Repository](https://github.com/OpenMOSS/MOSS-Music), [model card](https://huggingface.co/OpenMOSS-Team/MOSS-Music-8B-Instruct?hardware=jetson-t5000) |
| Local research Q&A | NVIDIA Music Flamingo | Rich full-song interpretation; official model card restricts it to noncommercial research. Keep out of the default product distribution. [Model card](https://huggingface.co/nvidia/music-flamingo-2601-hf) |
| Cloud musical interpretation | Gemini audio understanding | Supports audio questions, descriptions and timestamped analysis. Use only for an opted-in interpretation experiment; validate its events against signal-derived candidates. [Official audio guide](https://ai.google.dev/gemini-api/docs/audio?hl=en) |

The key model-license example is revealing: CueIt's README describes S-KEY models as MIT, while Deezer's own README explicitly excludes skey.pt weights from MIT. This does not establish the exact rights of every third-party artifact; it means upstream checkpoint terms must be checked before distribution. A similar review is needed for transitive weights in SongFormer/SCALE. These are implementation-selection constraints, not a reason to stop local research.

Separate three concepts in the model: an observed event, a musical interpretation, and a DJ's cue choice. An energy rise is not necessarily a drop; a chorus is not necessarily a drop; a downbeat is not necessarily a phrase boundary. A cue 16 bars before an event can be useful even when no structural boundary exists at that cue. Keep proposed offsets as explicit policies that depend on reliable beat/bar timing.

For stem-aware preparation, useful questions include: where does prominent vocal content enter; is there a sufficiently long instrumental mixing region; is an apparent energy change mostly percussion; and would two selected passages overlap vocals? Start with vocal/drum evidence and on-demand previews. Keep separated audio in an explicit derivative/cache directory. Separation artifacts, instrumental bleed and uncertain timing must not become confident musical labels. A two-track transition planner comes after single-track timing and review prove useful.

A text assistant could explain the measured evidence, translate a preference into a cue-layout preset, or query structured local metadata. It should refer to real candidate IDs and measured times. Do not allow it to invent precise timestamps or silently edit approved cues. Local language inference and audio-language inference are separate features with different resource requirements.

**Local execution should remain complete; cloud execution should be optional and visible.** The available hardware inventory command could not read Windows CIM resources, so this research did not establish the user's CPU, RAM, GPU or VRAM. No model throughput or hardware minimum has been measured here.

| Execution tier | Useful scope | Release condition |
| --- | --- | --- |
| CPU baseline | Decode, peaks, DSP features, queue/review; optionally small neural inference | Clean Windows install works offline after any explicit model download; measured memory and runtime |
| NVIDIA CUDA | Batch beats, optional stems/structure | Pin a tested PyTorch/model combination; detect unsupported devices; record fallback rather than silently changing behavior |
| Apple Silicon | Later MPS/CoreML-capable workers where the chosen model supports them | Separate model/runtime benchmark; do not infer support from PyTorch alone |
| AMD/Intel/other Windows accelerators | Later ONNX/WinML investigation | Verify export correctness, supported operators, precision and timing against the reference backend |
| Opt-in cloud GPU | Same pinned analysis worker for large jobs or hardware-limited users | Explicit files, cost estimate/cap, retention/deletion policy, cancel/retry and model provenance |
| Cloud audio-language API | Optional semantic second opinion | Consent per upload scope, limited data, validated output, recorded provider/model version |

ONNX Runtime's DirectML page now says new Windows feature development has moved to WinML. Therefore “just use DirectML” is not a sufficient accelerator strategy. Runtime availability also does not guarantee that a selected audio model converts correctly. [Official runtime guidance](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)

Prefer executing the same pinned worker locally and remotely over creating separate cloud-only analysis behavior. A provider such as Modal supports Python GPU jobs and usage-based billing; costs include load time and resource use, so estimate from end-to-end jobs rather than neural forward-pass speed. [GPU documentation](https://modal.com/docs/guide/gpu), [pricing and billing definitions](https://modal.com/pricing)

An illustrative budget calculation, not a performance estimate: at an assumed USD 1/GPU-hour, 1,000 tracks averaging 30 billable GPU-seconds each cost USD 8.33 in GPU time; at 120 seconds each, USD 33.33. CPU, RAM, model loading, retries, storage, transfer and provider billing rules add costs. Measure those terms before offering a per-track price. No cloud job or paid resource was created during this research.

Keep network access off by default. A failed local analysis must not trigger a silent upload. Model downloads should be explicit and cached; audio uploads are a different consent. A private track or unreleased production must remain reviewable without an account. Any future telemetry should exclude audio, paths and annotations unless separately chosen.

**A local browser review surface is the lowest-friction next GUI.** It extends an existing strength without committing to a cross-language desktop build immediately.

| GUI route | Benefits | Tradeoff and proposed use |
| --- | --- | --- |
| Static report plus browser file selection | Very small first audition experiment; no service required | File permission and persistence friction; useful for testing the review interaction |
| Loopback Python service plus web UI | Reuses Python/HTML, allows local playback and durable sessions, easy browser testing | Must serve only explicitly selected files and keep background analysis separate; recommended first complete review workflow |
| PySide6 | Native Python desktop/file dialogs; QMediaPlayer and accessibility APIs | Packaging, waveform widgets and Qt/codec license obligations; strongest native alternative. [Qt for Python](https://doc.qt.io/qtforpython-6.8/), [QMediaPlayer](https://doc.qt.io/qtforpython-6/PySide6/QtMultimedia/QMediaPlayer.html), [accessibility](https://doc.qt.io/qt-6/accessible.html) |
| Tauri around the proven web UI | Desktop packaging and controlled local file/process access | Adds Rust, JS, Python packaging and WebView2 testing; defer until the interaction works. [Sidecars](https://v2.tauri.app/develop/sidecar/), [prerequisites](https://v2.tauri.app/start/prerequisites/) |

The first useful screen is a track list and one listening workspace. Show the waveform, candidate cues and a short reason. Offer play-before-cue, loop-around-cue, accept/reject, time-based movement, undo, and next uncertain cue. Enable beat/bar movement only when the relevant beat/downbeat/meter map is validated. Keep diagnostic detail available on demand. Save manual decisions immediately to Magik's own project data and allow feedback export; do not require hand-editing CSV.

Accessibility should be an acceptance criterion: keyboard-complete operation, labeled buttons, visible focus, readable zoom, contrast, cues distinguished by text as well as color, a table alternative to the waveform, and screen-reader announcements for selected cue/time. Automated checks complement manual keyboard and assistive-technology testing. [Playwright accessibility guidance](https://playwright.dev/docs/accessibility-testing)

Browser playback is suitable for auditioning, but seek time is not the canonical analysis clock. Store timing in a defined decoded-audio coordinate system and map it to the original playback timeline, including any decoder delay. Provide a playable decoded-preview fallback for formats the browser cannot play, using the same timing convention as analysis. Bind any local service to loopback, validate origins and sessions for state-changing requests, and serve only selected inputs or approved derivatives. [HTMLMediaElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement) supplies playback/seek APIs. All-In-One's authors specifically report MP3 decoder offset variation, reinforcing the need to test decode-to-playback consistency rather than assume every decoder agrees. [Timing note](https://github.com/mir-aidj/all-in-one#concerning-mp3-files)

**Interoperability has three different scopes: interchange files, library inspection, and live device participation.** They should not share one vague “DJ integration” milestone.

| Route | Evidence and caveat | Appropriate scope |
| --- | --- | --- |
| Official rekordbox XML | Documented track URIs, tempo entries and cue/loop marks; published format document is old | First explicit import of a user-selected export. Later create a new XML file for user import. [Developer page](https://rekordbox.com/en/support/developer/), [specification](https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf) |
| pyrekordbox | MIT; 0.5.0 released 14 October 2026, Python 3.11+; broad XML/database/ANLZ capabilities | Evaluate XML-only operations; avoid automatic discovery and write-capable database sessions. [Package](https://pypi.org/project/pyrekordbox/) |
| Mixxx | GPL-2.0-or-later; reads rekordbox USB exports and Serato tags; documents transfer/decoder differences | Reference application and human QA, not a Python SDK or a target database to write. [Library manual](https://manual.mixxx.org/2.5/en/chapters/library.html), [license](https://raw.githubusercontent.com/mixxxdj/mixxx/main/LICENSE) |
| Serato tags and parsers | Serato states cue points are saved in audio files. serato-tools 5.4.1 is MIT/Python 3.12+ and exposes both reads and writes | Read-only comparison only. Writing cues to original tags violates the current constraint. [Official cue behavior](https://support.serato.com/hc/en-us/articles/226518228-Cue-Points), [parser package](https://pypi.org/project/serato-tools/) |
| Serato format research | Markers2 documentation is reverse engineered; triseratops is an MPL-2.0 Rust parser/serializer | Format evidence and test fixtures, with unsupported fields preserved or rejected explicitly. [Format research](https://github.com/Holzhaus/serato-tags), [triseratops](https://github.com/Holzhaus/triseratops) |
| Engine / libdjinterop | LGPL-3.0 C++; reads/writes Engine data; README support matrix stops at earlier versions than the current Engine download | Later read-only inspection of copies. Do not assume current Engine 5.3 compatibility. [Repository](https://github.com/xsco/libdjinterop) |
| Deep Symmetry Crate Digger | Parses export/ANLZ formats; EPL-2.0 with documented secondary-license conditions | Valuable read-only format reference. Generated parser licensing is distinct from the MIT Kaitai runtime. [Repository](https://github.com/Deep-Symmetry/crate-digger) |
| Beat Link / VirtualCdj | EPL-2.0 Java; Pro DJ Link live metadata, position and beat communication | Separate future live-show research. Device identity/network participation is more than offline parsing. [Repository](https://github.com/Deep-Symmetry/beat-link) |
| DJ Data Converter | MIT public code; documented Basic conversion is Traktor NML ↔ rekordbox XML, with older tested app versions | Reference for conversion semantics, not proof of universal modern compatibility. [Repository](https://github.com/digital-dj-tools/dj-data-converter) |
| Lexicon conversion | Documents format-specific losses and differing cue/grid capabilities | Useful comparator for an adapter loss report. [Limitations](https://www.lexicondj.com/manual/library-conversion-limitations) |

XML-only use of pyrekordbox still installs database dependencies: current upstream requires SQLAlchemy and sqlcipher3-wheels, and package initialization imports database modules. Prefer a small standalone adapter for the supported XML subset, with pyrekordbox as an optional comparator, unless a clean Windows installation demonstrates acceptable complexity. [Dependency declaration](https://raw.githubusercontent.com/dylanljones/pyrekordbox/master/pyproject.toml), [package imports](https://raw.githubusercontent.com/dylanljones/pyrekordbox/master/pyrekordbox/__init__.py)

Current pyserato documentation now includes MP3/FLAC cues and grids, not only crates, but its license was not established from inspected metadata. Prefer a dependency whose exact release and licensing can be verified. OneTagger is GPL-3.0 and useful as a tagging/UI reference; its stable 1.7.0 release dates to August 2023 despite later commits. Its core tag-writing workflow is outside Magik's audio-read-only boundary. [pyserato](https://pypi.org/project/pyserato/), [OneTagger repository](https://github.com/Marekkon5/onetagger), [release](https://github.com/Marekkon5/onetagger/releases/tag/1.7.0)

Export should identify losses: hot cue versus memory cue, slot count, color/name support, loops, variable tempo and decoder offsets. Do not apply a historical fixed millisecond correction universally. Do not market any adapter as lossless until its supported cases have been tested in the actual receiving application.

Engine's own backup guidance says its application backup excludes external-drive databases. Any separately scoped future Engine-writing work must first document backup, rollback, schema and acceptance criteria, as AGENTS.md requires. No production database-writing feature is included in this roadmap. [Engine backup guidance](https://support.enginedj.com/support/solutions/articles/69000815206)

Reverse engineering can help document formats, read explicitly selected copies and test compatibility. Emulation of Pro DJ Link or device behavior does not solve offline cue quality and creates a different testing and support problem. Keep any future live experiment on isolated fixtures/networks with explicit scope; no DRM bypass, license-check bypass or firmware copying is needed for the proposed roadmap.

**The proposed architecture preserves a small core and makes expensive capabilities optional.**

```mermaid
flowchart LR
    A[Read-only local audio] --> B[Decode and define timing]
    B --> C[Features and optional models]
    C --> D[Musical events and uncertainty]
    D --> E[Cue-layout policy]
    E --> F[Audition and human review]
    F --> G[Versioned Magik outputs]
    G --> H[Optional interchange file]
    C -. explicit opt-in .-> I[Same worker on cloud GPU]
    I -. versioned result .-> D
```

Keep Python/Typer/pytest. Add NumPy/librosa when the benchmark justifies them and use one canonical decoder path. Heavy model backends should run in a separate worker/environment if dependencies conflict. Do not force allin1's installation requirements into the basic CLI. Introduce a simple typed backend result before a general plugin framework. A local SQLite project store may later be useful for annotations/cache; that would be Magik-owned data, never a DJ software database.

The data contract needs distinct track identity, run identity, model/decoder/settings provenance and stable human cue IDs. Keep original detector output, an optional proposed correction, and the approved human cue separate. Store manual decisions independently of one model's timestamps. A cache key should include content identity, preprocessing, backend/model revision and relevant settings; changing a decoder invalidates timing-dependent cache entries. Absolute paths belong in local project state, with portable/redacted references in shareable feedback.

Represent beat timestamps and downbeats explicitly, allowing tempo changes and unknown meter. Keep waveform display peaks separate from analysis features. Scores should say what they measure; fixed heuristic scores should not display as calibrated percentages of correctness. Preserve schema-v1 field meanings and add optional information where compatible; use schema v2 for breaking reinterpretations. An algorithm version is separate from a schema version.

Toolchain improvements should serve reproducibility: a declared supported Python version, a lock/constraints policy, clean-environment installation, core CI on Windows plus another platform, optional decoder/model tests, pinned model checksums and a dependency/model license manifest. Use browser tests for the few interactions that matter: audition, edit, undo, persistence, feedback download and keyboard navigation. Avoid a wholesale Rust or frontend rewrite merely because another project chose one.

**Measure musical usefulness separately from software correctness.** Synthetic tests are necessary for invariants but cannot establish that a cue helps a DJ.

| Evaluation layer | What to measure | Test material |
| --- | --- | --- |
| Safety and outputs | Input hashes unchanged; no DJ writes; collision refusal; coherent partial-failure behavior; deterministic identities | Generated files and isolated fake library/export fixtures |
| Timing correctness | Long-track event time, offset/phase, sample-rate conversion, decoder delay, valid cue bounds | Generated impulses, clicks, tones, silence, leading offsets and long arrangements |
| Rhythm | Exact tempo plus octave-aware accuracy; beat/downbeat precision/recall; timing error; continuity/drift; abstention | Broad synthetic tempo/meter/swing/change cases, then consented real-audio evaluation |
| Structure | Boundary error at declared tolerances; section-label confusion; vocal entry/exit error; uncertain intervals | Manually annotated user-owned or appropriately licensed tracks kept outside the public test suite |
| DJ value | Useful cues accepted unchanged, corrected/rejected/missing cues, correction magnitude and review time | Paired manual-versus-assisted sessions in the target repertoire |
| Runtime/access | End-to-end cold/warm time, RAM/VRAM/disk, CPU fallback, install success, keyboard completion | Named hardware configurations and clean user environments |

Use mir_eval as a measurement toolkit, not as the product's definition of success. Its beat documentation notes a common convention of ignoring the opening five seconds. Magik should also report the full beginning because the first usable cue is central to the product. Report exact and octave-tolerant tempo separately so half-time answers cannot hide genuine errors. [Beat evaluation documentation](https://mir-eval.readthedocs.io/latest/api/beat.html)

Proposed pilot: 30–50 permitted tracks in one declared repertoire and cue convention, with a held-out subset chosen before tuning. Recruit 3–5 DJs when the workflow is usable. Start with the user's own judgments, then record reviewer disagreement as acceptable ranges or alternatives. Do not redistribute those recordings or make them a network dependency of automated tests. Synthetic-only CI remains mandatory.

Suggested pilot targets, to revise from baseline measurements: at least 30% lower median review/preparation time, at least 80% acceptance of surfaced high-score cues, and no increase in missing critical cues compared with manual preparation. Always report cue coverage and abstention alongside acceptance; an engine that suggests almost nothing must not appear successful. Include setup time, failed tracks and transfer friction in the overall workflow assessment.

**The roadmap should advance through evidence gates.** These milestones are a proposed replacement for the old scaffold/review/export sequence, not calendar promises.

| Milestone | Deliverable | Exit gate |
| --- | --- | --- |
| M0 — Correctness and reproducibility | Fix analysis/display timebase separation; collision-safe identities; explicit rerun/output policy; reproducible tests; baseline timing benchmark | Long-track transitions remain at correct times; original files unchanged; duplicates/collisions handled; full suite reproducible; unsupported inputs produce useful messages |
| M1 — Reliable rhythm evidence | Compare improved DSP and Beat This! behind a narrow backend interface; real beat/phase/downbeat representation where supported | Publish exact/octave-aware tempo and beat/downbeat results, failure cases, runtime and provenance; no automatic snap from an unvalidated grid |
| M2 — Complete local review loop | Play/seek/loop, accept/reject/move/undo, durable annotations, uncertainty queue, comparison across runs | A reviewer can finish and reopen a review using only the GUI/keyboard; decisions survive reanalysis; feedback export works in a real browser |
| M3 — Useful cue conventions and optional stems | Small cue-layout presets based on validated events; vocal/drum evidence on demand; structure model comparison | Held-out pilot improves preparation time/quality over corrected baseline; stem feature retained only if its benefit justifies latency/storage |
| M4 — Supported file interchange | Read user-exported rekordbox XML, preserve imported provenance, export a new reviewed interchange file with loss report | Fixture round trips; separately scoped receiving-app checks use disposable isolated test libraries and generated audio; production music/libraries untouched; conflicts and unsupported cue types visible |
| M5 — Accessible packaging and optional cloud | Windows install/launcher, capability probe and model manager; optional cloud worker for measured use cases | Clean-machine install, offline completion and cancel/resume; no GPU/cloud account required for baseline review. If cloud is enabled, also validate explicit upload/cost/retention behavior; cloud does not block the local release |

M1 and a thin M2 prototype can progress together once M0 timing and identity are stable. M3 depends on reliable rhythm plus useful review. XML research can continue early, but shipping transfer depends on preserved human decisions and receiving-app tests. Packaging experiments should start early enough to expose Windows dependency problems; production installers come after the workflow is worth distributing.

The immediate small work packages are: reproduce the long-track timing bug in an automated synthetic test; correct its timebase without breaking v1 field meanings; add phase-offset and tempo-sweep benchmarks; clarify hypothetical-grid language; preflight output names and reruns; establish stable track/run/annotation identity; and prototype audition plus one correction action. Each should be independently reviewable. Do not add more diagnostic tables as a substitute for those results.

A calendar estimate would be premature before a clean install, a selected model and hardware benchmarks. The first target is a useful small-library pilot, not universal genre accuracy or a tens-of-thousands-of-tracks manager. A research model's reported speed or benchmark score is not an app-level delivery estimate.

**The proposed rules preserve safety while retiring temporary experiment constraints.**

| Keep as a hard rule | Clarify or add | Retire as a permanent constraint |
| --- | --- | --- |
| Original audio is read-only | Read-only includes embedded tags and cue metadata | “No new dependencies” from early narrow tasks; allow measured, justified dependencies |
| No writes to any DJ software database | Separate interchange files, Magik-owned project state and vendor libraries | Freezing generated cue behavior forever; future versioned algorithms need intentional measured changes |
| Generated synthetic audio for automated tests | Permitted private listening sets are separate, optional and never redistributed by default | Treating a compact display envelope as the analysis signal |
| No overwrite unless explicitly supported/documented | Consistent sidecar/report policy, preflight, exclusive/atomic creation and useful failures | Treating more report diagnostics as proof of better musical results |
| Clear reasons, confidence information and human review | Distinguish heuristic score from probability, tempo from beat/phase/bar/phrase, and detector output from user-approved cues | Assuming every useful cue is at a model's section boundary |
| Small reviewable changes | Each analysis change records baseline, expected gain, regression cases and runtime | Building a general plugin framework before two concrete backends need it |
| Local-first operation | Explicit model downloads; separate audio-upload consent; offline path; no silent cloud fallback | Treating cloud or a large language model as necessary for all analysis |
| Careful path validation | Stable identity, Unicode/URI handling, bounds, timeouts and selected-file serving | Assuming filenames uniquely identify recordings |

Add a model manifest covering exact revision/checksum, code license, weight license, required notices, input sample rate, preprocessing, output timebase and benchmark results. Research-only/noncommercial components must stay in appropriately scoped experiments unless further rights are established. Preserve unknown imported metadata or report losses rather than silently discarding it.

The current repository has no declared project LICENSE among its tracked files. Select the project's intended license and distribution model before incorporating copyleft components or promising an open-source release. This is a project decision; a public repository alone is not a license grant.

**A build-versus-contribute checkpoint should happen before a large rewrite.** Compare the same permitted small track set and review task in the corrected Magik prototype, CueIt and one established preparation tool. Inspect TimeCues for annotation/evaluation ideas. Assess manual correction time, bad suggestions, installation friction, export loss and preservation of user edits. If another open project already supplies the desired experience, contributing an evaluation backend, safety-oriented output adapter or accessible review component may be more useful than duplicating it.

Continue independent development if Magik demonstrates a clear benefit in the chosen task. Reconsider the direction if another tool performs it just as well, if deployment/licensing makes the chosen models unsuitable, or if manual transfer consumes the time saved in analysis. A narrower, excellent review companion is a worthwhile outcome; a universal DJ suite is not required.

The next project conversation can settle four decisions from this evidence: the first audience/repertoire, the user's cue convention, whether the intended distribution is personal/open-source/commercial, and the hardware on which to establish performance targets. None prevents the M0 correctness work from being specified. The recommended next implementation milestone is M0, with a thin audition-and-correction experiment immediately after its timing/identity foundations.
