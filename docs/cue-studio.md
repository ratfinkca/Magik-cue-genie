# Cue Studio guide

[Run Cue Studio locally](../README.md#run-locally) for the full preparation workflow. The static GitHub Pages build runs the decks and Library with browser-local audio. New Python analysis and generated stems require the local Studio server.

## Load and mix

Open audio on Deck A or B, or use **Load A** and **Load B** from the Library. The sparkle beside **Deck controls** loads a generated pair for testing. Each deck plays and pauses independently. Set their start positions and choose **Play both** to launch both on the same clock. **Key Lock** uses a browser AudioWorklet to preserve pitch during tempo changes on supported browsers.

**Sync** matches the other deck's current BPM and can align phase where both decks have beat timing. Choose **One-shot** for a single match or **Follow tempo** to keep that deck's tempo linked. Tap the linked Sync button again or move its Tempo fader to release it. **Tap tempo** as the Sync reference uses at least three taps. A fresh tap pattern can supply phase, and later taps refine the BPM.

The large waveforms scroll behind a fixed playhead. Click to seek, drag to scrub audio, and use Shift+scroll to nudge by 10 ms. The overview shows the full track with cue and loop positions. **RGB** blends spectral colors, **Tri-band** layers three frequency bands, and **Split** draws the bands separately. Use the grid menu to show seconds, beats, and bars. Dashed lines are estimates or projections.

The mixer has per-deck Gain, stereo Pan, three-band EQ, and a low-pass/high-pass Filter. **Response** plots their combined response at the waveform. Drag a knob or use arrows to adjust it. Double-click to reset, or Shift-double-click an EQ knob to reset all three bands on that deck. The crossfader offers Equal power, Linear, Sharp, and Custom curves. **Master Out** controls the combined signal. Deck meters read after the channel effect and before the crossfader.

Enable **FX** on a deck and adjust **FX Mix** to blend the effect. Choose Echo, Ping Pong Delay, Room Reverb, Flanger, or Tremolo. Echo and Ping Pong can use delay lengths chosen from the current deck BPM. If you adjust the deck tempo after selecting a division, select the division again to recalculate the delay.

## Prepare beats and cue points

Open **Cue points**, choose the deck, and select **Analyze**. The loopback server runs Python against a temporary file on your machine. The request limit is 100 MiB and analysis supports up to 30 minutes. Studio can pass a bounded PCM copy of browser-decoded audio when the encoded file exceeds the request limit or the Python decoder cannot read it.

Tempo and beat timing are separate results. The analyzer checks for a stable pulse and looks for supported kick timing, so it can return BPM while withholding beat positions. **Mix in** and **Mix out** are rehearsal cues. Audition their downbeat, phrase, and transition suitability by ear. Tempo and key can also use embedded tags. Choose Standard, Camelot, or Open Key in the waveform toolbar. Reanalysis keeps your manual cue edits and retains valid timing when the new analysis cannot replace it.

For a steady track, open **Beatgrid**, park the playhead on the intended first downbeat, and choose **Use playhead**. Confirm the BPM and save. The manual anchor counts as Bar 1 and supports Quantize and Sync. Check alignment near the start and end. **Clear manual grid** restores the underlying estimate or observed grid. An enabled Beat This model can show a dashed display grid when acoustic timing is unavailable.

Add or select a cue, then edit its label, time, or color in the inspector. **Mark lead-in** adds a linked cue counted in seconds, beats, or bars. Beat and bar lead-ins use the adjusted deck BPM or an explicit override. The default inserts the lead-in before its cue; use **At end** to keep the existing numbering. Pre-roll can extend up to 10 minutes before the audio. At 120 BPM in 4/4, a 16-bar lead-in before zero starts at −32 seconds on a deck at normal speed. Playback counts down silently to zero.

The audition preference can continue playback, loop the excerpt, or pause at its end. **Hot cues** is a separate setting for the pads below the overviews. **Play through** jumps and plays, **Play on release** waits for release to play, and **Hold to play** returns to a paused cue on release. Pads also accept Space and Enter. **Preferences** controls default colors for named cues, minimum suggestion confidence, vocal proposals, and emergency-loop behavior.

## Use and edit loops

Draw a live loop on the overview. You can also capture **In**, move the playhead to the desired end, and capture **Out**. The pending preview grows as the playhead moves. The length bank is **⅛ / ¼ / ½ / 1 / 2× / 4× / 8×**. With a live loop, the side buttons multiply its current length and keep In fixed. **1** sets one beat. With no live loop, the bank uses a one-beat base at the pending In point or playhead.

Drag **In**, **Out**, or **Move** on either waveform to edit a range. Move preserves its length. Quantize uses supported beat positions and subdivisions; Shift-drag lets you adjust freely. **Exit** leaves the live loop and **Re-loop** recalls its range. **Save loop** adds it to Cue points. In the cue inspector, **Trim on waveform** opens an edit you can save or cancel. **Use loop** engages the saved range immediately; **Arm loop** makes it the track's single automatic loop.

An automatic emergency loop requires steady audio and consecutive observed acoustic beats near the tail. A manual grid alone does not supply that evidence. Vocal loop suggestions start unarmed. You can also use an aligned vocal stem from disk for proposals. Use **Download JSON** and **Import** in Cue points to move one track's preparation as a sidecar.

## Build a Library and plan a transition

**Add tracks** and **Add folder** copy selected media into the browser Library and retain relative folder paths. Opening a deck file also adds it. The Library identifies equal audio bytes by SHA-256, so both decks can share a track's cue edits and analysis. Folder import captures the files as they exist at import time. Choose a folder again to pick up changes.

Search tracks and folders, or open **Filters** to combine column rules with **Match all** or **Match any**. Genre comes from embedded tags; **Refresh genre tags** fills the field for older stored tracks. Analysis status, cue count, and the manual **Reviewed** or **Approved** state are independent. Select tracks to run **Analyze selected** or **Prepare stems** one at a time. You can cancel the queue or reuse existing preparation.

Choose a track as the mix reference to compare BPM, genre, estimated energy, and available outro-to-intro timing. Energy uses a local 1–10 estimate from measured level, activity, and dynamics. Phrase windows inferred from rhythm are estimates. Review which factors contribute to a match, and listen to the actual overlap before using it.

Check tracks and create a playlist or add them to an existing one. Playlist order is stored with preparation and track copies in this browser. Changing browser profiles, hostnames, or ports opens a different Library. Last opened decks restore paused. **Diagnostics → Forget saved decks** clears their assignments and playhead positions. **Download log** exports diagnostic events for troubleshooting.

### Back up the Library

Choose **Backup → Save backup JSON** for playlists, track references, cue preparation, review status, and settings, including MIDI mappings. Keep your original audio separately. Backups do not contain audio or generated stems.

Use **Open backup JSON** to preview a restore. Existing preparation is kept by default. When a restored entry needs audio, add the original file or folder to link it by content even if the filename has changed. Reload to apply restored preferences.

### Import and export playlists

Use **Library → Import / export** to inspect M3U, M3U8, or rekordbox XML. Review the proposed path matches and explicitly choose local audio for unmatched tracks. Import creates ordered Studio playlists. An XML import can add cues, loops, and tempo segments when a track has no existing preparation.

On a desktop browser with a writable folder picker, export a playlist to a new folder containing audio copies, a relative M3U8, and an export report. When including rekordbox XML, enter the full path to the selected parent folder so its absolute media references point at the copies. XML supports cues, loops, imported tempo segments, and constant-tempo manual grids in 4/4. Check the export report before using the receiving app's own device export workflow. [Published rekordbox XML format](https://rekordbox.com/en/support/developer/)

## Map USB MIDI

Connect a controller that your operating system recognizes as a MIDI input. Open **MIDI** beside the Library and Cue points tabs, select **Enable MIDI**, and grant browser access if prompted. Choose the input and **Learn** beside a control. Press a hardware button or move a knob or fader. Choose **Remove** to clear a binding. Profiles belong to each browser input ID and are included in backups.

Mapping supports Note On/Off and 7-bit Control Change. Targets include transport, hot cues, sync, loops, tempo, channel EQ, FX, crossfader, master output, and prepared stem levels. Absolute controls take over when the hardware reaches or crosses the on-screen value. Hot cue pads follow the Studio hot cue setting. This is controller input; controller audio and LED feedback require separate integrations. [Web MIDI specification](https://www.w3.org/TR/webmidi/)

## Configure optional local models

Use the environment variables on the machine running the local Studio server, then restart it. Model weights are installed separately. Inference runs on your machine.

| Capability | Configuration |
| --- | --- |
| Vocal loop proposals from the full mix | Run `python scripts/setup_studio_vocals.py` from the checkout with the interpreter Studio uses. [YAMNet setup and limits](studio-vocals.md) |
| Fallback beat display | Set `MAGIK_BEAT_THIS_PYTHON` to a Python executable with Beat This installed and `MAGIK_BEAT_THIS_CHECKPOINT` to its official `small0` checkpoint. [Beat This upstream setup](https://github.com/CPJKU/beat_this) |
| Four-stem separation | Set `MAGIK_STEMS_PYTHON` to an environment with Demucs 4.0.1, PyTorch, torchaudio, and NumPy. Set `MAGIK_STEMS_WEIGHTS` to the directory containing its official `htdemucs` checkpoint `955717e8-8726e21a.th`. `MAGIK_STEMS_DEVICE` defaults to `cpu` and can be set to `cuda` on a compatible system. [Demucs upstream setup](https://github.com/facebookresearch/demucs) |

Choose **Separate stems** in a deck's mixer channel, or use the Library's **Prepare stems** queue. The preview accepts tracks from 2 seconds to 6 minutes and separates one at a time. Adjust **Vocals**, **Drums**, **Bass**, and **Other** independently. At 100% on all four knobs, the deck uses the original mix.

Aligned stems are cached by audio fingerprint and timeline. They can be restored while running the local server. The cache holds up to 4 GiB by default. Set `MAGIK_STEMS_CACHE_DIR` to an absolute local folder to override the operating system's cache directory.
