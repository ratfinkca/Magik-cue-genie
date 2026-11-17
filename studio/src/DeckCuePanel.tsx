import { useId, useRef, useState } from "react"
import type { CSSProperties } from "react"
import type { AuditionBehavior } from "./audio"
import { MAX_MANUAL_GRID_BPM, MIN_MANUAL_GRID_BPM } from "./beatGrid"
import type { CueEditPatch } from "./cueEdit"
import { cueColor, formatTime } from "./cues"
import type { Cue } from "./cues"
import { cueIdentity } from "./cuePreparation"
import type { DeckCueSession } from "./deckCues"
import { formatKey } from "./key"
import type { KeyNotation } from "./key"
import type { LeadInPlacement, LeadInUnit } from "./leadIn"
import { leadInPlaybackRate } from "./leadIn"
import { LOCAL_BACKEND_REQUIRED, studioLocalBackendAvailable } from "./localBackend"
import { getLoop } from "./loops"
import { quantizeTime } from "./quantize"
import type { QuantizeMode } from "./quantize"
import { cueNameColor, displayCueColor } from "./studioPreferences"
import type { CueColors } from "./studioPreferences"
import { clampTrackTime, MIN_TRACK_SECONDS } from "./trackTime"
import "./deckCuePanel.css"

interface Props {
  deckId: "A" | "B"
  session: DeckCueSession
  cueColors?: CueColors
  position: number
  getPosition?: () => number
  playbackRate?: number
  seek: (seconds: number) => void
  quantize: QuantizeMode
  leadInPlacement: LeadInPlacement
  onLeadInPlacementChange: (value: LeadInPlacement) => void
  keyNotation?: KeyNotation
  activateLoop?: (start: number, end: number) => void
  onTrimLoop?: (cue: Cue) => void
  audition?: (cue: Cue, leadSeconds: number) => void
  auditionBehavior?: AuditionBehavior
  onAuditionBehaviorChange?: (behavior: AuditionBehavior) => void
  onLoopArmedChange?: (cue: Cue, armed: boolean) => void
}

type CueDraft = {
  owner: DeckCueSession["owner"]; id: string
  label?: string; seconds?: string; endSeconds?: string; color?: string | null; error?: string
}

type GridDraft = { owner: DeckCueSession["owner"]; bpm?: string; anchor?: string; error?: string }

function LoopAction({ label, hint, name, onClick, disabled, pressed }: {
  label: string; hint: string; name?: string; onClick: () => void
  disabled?: boolean; pressed?: boolean
}) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  return <span className="deck-cue-loop-action" data-dismissed={dismissed}
    onPointerLeave={() => setDismissed(false)} onBlur={() => setDismissed(false)}
    onKeyDown={event => { if (event.key === "Escape") setDismissed(true) }}>
    <button className="quiet" type="button" aria-label={name} aria-describedby={id} aria-pressed={pressed}
      aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onClick() }}>{label}</button>
    <span className="deck-cue-loop-hint" id={id} role="tooltip">{hint}</span>
  </span>
}

export default function DeckCuePanel({ deckId, session, cueColors, position, getPosition, playbackRate = 1, seek, quantize,
  leadInPlacement, onLeadInPlacementChange, keyNotation = "standard",
  activateLoop, onTrimLoop, audition, auditionBehavior = "continue", onAuditionBehaviorChange,
  onLoopArmedChange }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const stemInput = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<CueDraft | null>(null)
  const [gridDraft, setGridDraft] = useState<GridDraft | null>(null)
  const { unit, amount, meter, tempoOverride } = session.leadIn
  const selected = session.selected === null ? undefined : session.cues[session.selected]
  const cueId = cueIdentity(selected)
  const activeDraft = draft && draft.owner === session.owner && draft.id === cueId ? draft : null
  const selectedLoop = selected && getLoop(selected, session.duration)
  const canArmLoop = session.selected !== null && session.canToggleLoop(session.selected)
  const selectedColor = activeDraft?.color !== undefined ? activeDraft.color : selected && cueColor(selected)
  const inheritedColor = selected && cueNameColor(selected.label, cueColors)
  const busy = session.status === "queued" || session.status === "running"
  const deck = "Deck " + deckId
  const activeGridDraft = gridDraft?.owner === session.owner ? gridDraft : null
  const gridBpm = activeGridDraft?.bpm ?? (session.bpm === null ? "" : String(Number(session.bpm.toFixed(3))))
  const gridAnchor = activeGridDraft?.anchor ?? (session.manualGrid ? String(session.manualGrid.anchor_seconds) : "")
  const gridPlayingStatus = session.manualGrid ? "Manual" : session.modelGrid ? "Beat This estimate"
    : session.observedBeatTimes.length >= 2 ? "Measured" : "No grid"
  const tempo = tempoOverride.trim() ? Number(tempoOverride) : undefined
  const rate = leadInPlaybackRate(playbackRate)
  const effectiveBpm = session.bpm === null ? null : session.bpm * rate
  const tempoSource = session.bpmSource === "manual" ? "Manual beatgrid" : session.bpmSource === "file_tag" ? "File tag"
    : session.bpmSource === "estimate" ? "Tempo estimate" : "Beatgrid tempo"
  const keySource = session.key?.method === "file-tag" ? "File tag"
    : session.key?.method === "demo" ? "Demo key" : "Key estimate"
  const leadPreview = session.leadInPreview(unit, Number(amount), Number(meter), quantize, tempo, rate)
  const leadOffset = session.leadInOffset(unit, Number(amount), Number(meter), tempo, rate)
  const auditionLead = leadOffset ?? 2
  const leadTooEarly = selected && leadOffset !== null && selected.time_seconds - leadOffset < MIN_TRACK_SECONDS
  const vocalStatus = session.sidecar?.analysis.studio_vocals
  const vocalMessage = vocalStatus && typeof vocalStatus === "object" && "message" in vocalStatus
    && typeof vocalStatus.message === "string" && (!('status' in vocalStatus) || vocalStatus.status !== "ready")
    ? vocalStatus.message : null
  const snap = (seconds: number) => quantizeTime(clampTrackTime(seconds, session.duration), session.beatTimes, quantize)
  function updateDraft(patch: Partial<Omit<CueDraft, "owner" | "id">>) {
    if (!cueId) return
    setDraft(previous => ({ ...(previous?.owner === session.owner && previous.id === cueId ? previous : null),
      owner: session.owner, id: cueId, error: undefined, ...patch }))
  }

  function updateGridDraft(patch: Partial<Omit<GridDraft, "owner">>) {
    setGridDraft(previous => ({ ...(previous?.owner === session.owner ? previous : null),
      owner: session.owner, error: undefined, ...patch }))
  }

  return (
    <section className="deck-cue-panel" aria-label={deck + " cue points"} data-deck-cues={deckId}>
      <div className="deck-cue-header">
        <h3>{deck} cues</h3>
        {session.bpm !== null && <span title={tempoSource}>
          {session.bpm.toFixed(1)} BPM{session.bpmSource === "manual" ? " · manual"
            : session.bpmSource === "file_tag" ? " · tag" : session.bpmSource === "estimate" ? " · est." : ""}
        </span>}
        {session.available && <span aria-label={deck + " key"} title={session.key ? keySource : undefined}>
          {session.key ? formatKey(session.key, keyNotation) : session.keyPending ? "Finding key…" : "Key unclear"}
          {session.key?.method === "file-tag" ? " · tag" : session.key && session.key.method !== "demo" ? " · est." : ""}
        </span>}
        {session.available && <span data-dirty={session.dirty || session.prepStatus === "error"}>
          {session.prepStatus === "saving" ? "Saving prep…" : session.prepStatus === "error" ? "Prep not saved"
            : session.dirty ? "Unsaved cue edits" : session.prepStatus === "saved" ? "Library prep saved" : "No unsaved edits"}
        </span>}
        <button className="quiet" type="button" aria-label={"Analyze " + deck} disabled={!session.canAnalyze || busy}
          title={studioLocalBackendAvailable() ? undefined : LOCAL_BACKEND_REQUIRED}
          onClick={session.analyze}>Analyze</button>
      </div>
      {!session.available ? <p className="deck-cue-note">Open a track to work with its cues.</p> : <>
        <div className="deck-cue-actions">
          <button className="quiet" type="button" aria-label={"Add cue on " + deck}
            onClick={() => session.addCue(snap(getPosition?.() ?? position))}>Add cue</button>
          <button className="quiet" type="button" aria-label={"Undo " + deck + " cue edit"}
            disabled={!session.canUndo} onClick={session.undo}>Undo</button>
          <button className="quiet" type="button" aria-label={"Import cues to " + deck}
            disabled={busy} onClick={() => input.current?.click()}>Import</button>
          <button className="quiet" type="button" aria-label={"Export cues from " + deck}
            disabled={busy} onClick={session.downloadCues}>Download JSON</button>
          <button className="quiet" type="button" aria-label={"Use vocal stem on " + deck}
            title={session.bpm === null ? "Analyze the track to find its BPM first." : "Choose an aligned isolated vocal stem."}
            disabled={session.bpm === null || session.stemBusy} onClick={() => stemInput.current?.click()}>Use vocal stem</button>
          <input type="file" accept=".json,application/json" ref={input} hidden
            aria-label={deck + " cue sidecar"}
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ""
              if (file) void session.importCues(file)
            }} />
          <input type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.aif,.aiff,.ogg" ref={stemInput} hidden
            aria-label={deck + " isolated vocal stem"}
            onChange={event => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ""
              if (file) void session.suggestFromStem(file)
            }} />
        </div>
        {session.message && <p className="deck-cue-note" data-error={session.status === "error"} role="status">
          {session.message}
        </p>}
        {session.stemMessage && <p className="deck-cue-note" data-error={session.stemError} role="status">{session.stemMessage}</p>}
        {session.prepStatus === "error" && <p className="deck-cue-note" data-error="true" role="status">
          Could not save to the library. Download JSON to keep these cues.
        </p>}
        {vocalMessage && <p className="deck-cue-note">{vocalMessage}</p>}
        <details className="deck-cue-beatgrid">
          <summary>Beatgrid <span>· {gridPlayingStatus}</span></summary>
          <form className="deck-cue-grid-edit" aria-label={deck + " manual beatgrid"} noValidate onSubmit={event => {
            event.preventDefault()
            const error = session.saveManualGrid(gridAnchor.trim() ? Number(gridAnchor) : NaN, Number(gridBpm))
            if (error) updateGridDraft({ error })
            else setGridDraft(null)
          }}>
            <p className="deck-cue-note">{session.modelGrid
              ? "Beat This estimated the beat positions. Find a kick on the first beat of a bar and set it as the anchor."
              : "Set a steady grid by anchoring the first beat of a bar on the waveform."}</p>
            <div className="deck-cue-grid-fields">
              <label>BPM
                <input type="number" min={MIN_MANUAL_GRID_BPM} max={MAX_MANUAL_GRID_BPM} step="0.001" value={gridBpm}
                  disabled={busy} onChange={event => updateGridDraft({ bpm: event.target.value })} />
              </label>
              <div className="deck-cue-loop-point">
                <label>Anchor time (s)
                  <input type="number" min={0} max={session.duration} step="0.001" value={gridAnchor}
                    disabled={busy} onChange={event => updateGridDraft({ anchor: event.target.value })} />
                </label>
                <button className="quiet" type="button" disabled={busy} onClick={() => {
                  const seconds = getPosition?.() ?? position
                  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= session.duration) {
                    updateGridDraft({ error: "Place the playhead on a beat within the audio." })
                    return
                  }
                  updateGridDraft({ anchor: String(Number(seconds.toFixed(6))) })
                }}>Use playhead</button>
              </div>
            </div>
            <div className="deck-cue-actions">
              <button className="quiet" type="submit" disabled={busy}>Save beatgrid</button>
              {session.manualGrid && <button className="quiet" type="button" disabled={busy} onClick={() => {
                session.restoreAnalyzedGrid()
                setGridDraft(null)
              }} title="Return to the analyzed grid when available.">Clear manual grid</button>}
            </div>
            {activeGridDraft?.error && <p className="deck-cue-note" data-error="true" role="alert">{activeGridDraft.error}</p>}
          </form>
        </details>
        {quantize !== "off" && session.beatTimes.length < 2 && <p className="deck-cue-note">
          {session.modelGrid ? "Set a manual beatgrid to snap to corrected beat positions."
            : session.status === "ready" ? "The beatgrid has too few usable beats for snapping."
              : "Analyze the track or set a beatgrid to enable snapping."}
        </p>}
        <div className="deck-cue-columns">
          {session.cues.length > 0 ? <ul className="deck-cue-list">
            {session.cues.map((cue, i) => <li key={cueIdentity(cue) ?? i}>
              <button className="quiet" type="button" aria-pressed={session.selected === i}
                style={{ "--cue-color": displayCueColor(cue, cueColors) } as CSSProperties}
                data-lead={Boolean(cue.metadata?.lead_in)} title={cue.reason}
                onClick={() => { session.select(i); seek(cue.time_seconds) }}
                onDoubleClick={audition ? () => audition(cue, auditionLead) : undefined}>
                <span>{i + 1}. {cue.label}</span>
                <span className="time">{formatTime(cue.time_seconds, true)}</span>
              </button>
            </li>)}
          </ul> : <p className="deck-cue-note">Add a cue or analyze the track for suggestions.</p>}
          <div className="deck-cue-inspector">
            {selected && session.selected !== null && (
              <form className="deck-cue-edit" key={cueId} noValidate={Boolean(selectedLoop)}
                onSubmit={event => {
                  event.preventDefault()
                  if (session.selected === null || !activeDraft) return
                  const patch: CueEditPatch = { label: activeDraft.label, color: activeDraft.color }
                  if (activeDraft.seconds !== undefined) {
                    const time = Number(activeDraft.seconds)
                    if (!activeDraft.seconds.trim() || !Number.isFinite(time)) return updateDraft({ error: "Enter a valid start time." })
                    patch.time_seconds = selectedLoop || time === selected.time_seconds ? time : snap(time)
                  }
                  if (activeDraft.endSeconds !== undefined) {
                    if (!activeDraft.endSeconds.trim()) return updateDraft({ error: "Enter a valid loop end." })
                    patch.loopEndSeconds = Number(activeDraft.endSeconds)
                  }
                  const error = session.updateCue(session.selected, patch)
                  if (error) updateDraft({ error })
                  else setDraft(null)
                }}>
                {selected.metadata?.requires_review === true && <p className="deck-cue-note">Review this suggestion by ear.</p>}
                <p className="deck-cue-note">{selected.reason}</p>
                <div className="deck-cue-name-color">
                  <label>Cue name
                    <input name="label" aria-label={deck + " cue name"} value={activeDraft?.label ?? selected.label}
                      onChange={event => updateDraft({ label: event.currentTarget.value })} maxLength={72} required />
                  </label>
                  <div className="deck-cue-color-controls">
                    <label>Cue color
                      <input type="color" value={selectedColor ?? inheritedColor ?? (deckId === "A" ? "#78f3c3" : "#ffd474")}
                        aria-label={deck + " cue color"} onChange={event => updateDraft({ color: event.currentTarget.value })} />
                    </label>
                    <button type="button" className="quiet" aria-label={"Use default color for " + deck + " cue"}
                      title="Use the preference for this cue name, or the deck color."
                      disabled={!selectedColor} onClick={() => updateDraft({ color: null })}>Default</button>
                  </div>
                </div>
                {selectedLoop && onTrimLoop && <div className="deck-cue-actions">
                  <LoopAction label="Trim on waveform" name={"Trim saved loop on " + deck + " waveform"}
                    hint={activeDraft?.seconds !== undefined || activeDraft?.endSeconds !== undefined
                      ? "Pause this deck and trim from the saved endpoints. This clears unsaved time edits."
                      : "Pause this deck and edit the saved range by dragging either waveform handle."}
                    onClick={() => {
                      if (activeDraft?.seconds !== undefined || activeDraft?.endSeconds !== undefined) {
                        updateDraft({ seconds: undefined, endSeconds: undefined })
                      }
                      onTrimLoop(selected)
                    }} />
                </div>}
                {selectedLoop && <details className="deck-cue-exact-times" open={!onTrimLoop || undefined}>
                  <summary>Exact times</summary>
                  <div className="deck-cue-loop-fields">
                    {(["start", "end"] as const).map(boundary => {
                      const field = boundary === "start" ? "seconds" : "endSeconds"
                      return <div className="deck-cue-loop-point" key={boundary}>
                        <label>Loop {boundary} (s)
                          <input type="number" step="any" min={0} max={session.duration} required
                            aria-label={deck + " loop " + boundary + " (seconds)"}
                            value={activeDraft?.[field] ?? (boundary === "start" ? selected.time_seconds : selectedLoop.end_seconds)}
                            onChange={event => updateDraft({ [field]: event.currentTarget.value })} />
                        </label>
                        <button className="quiet" type="button" aria-label={"Set " + deck + " loop " + boundary + " from playhead"}
                          onClick={() => {
                            const time = snap(getPosition?.() ?? position)
                            updateDraft({ [field]: String(time) })
                          }}>Playhead</button>
                      </div>
                    })}
                  </div>
                </details>}
                <div className="deck-cue-edit-line" data-loop={Boolean(selectedLoop)}>
                  {!selectedLoop && <label>Time (s)
                    <input type="number" name="seconds" aria-label={deck + " cue time (seconds)"}
                      title="Negative values mark up to 10 minutes of silent pre-roll."
                      step="any" min={MIN_TRACK_SECONDS} max={session.duration}
                      value={activeDraft?.seconds ?? selected.time_seconds}
                      onChange={event => updateDraft({ seconds: event.currentTarget.value })} required />
                  </label>}
                  <button className="quiet" type="submit" aria-label={"Save " + deck + " cue"}>Save</button>
                  <button className="quiet" type="button" aria-label={"Remove " + deck + " cue"}
                    onClick={() => { if (session.selected !== null) session.removeCue(session.selected) }}>Remove</button>
                </div>
                {activeDraft?.error && <p className="deck-cue-note" data-error="true" role="alert">{activeDraft.error}</p>}
                {(audition || selectedLoop) && <div className="deck-cue-actions">
                  {audition && <button className="quiet" type="button" aria-label={"Audition " + deck + " cue"}
                    onClick={() => audition(selected, auditionLead)}>Audition</button>}
                  {audition && onAuditionBehaviorChange && <label>After audition
                    <select value={auditionBehavior} onChange={event =>
                      onAuditionBehaviorChange(event.currentTarget.value as AuditionBehavior)}>
                      <option value="continue">Continue</option><option value="loop">Loop</option><option value="pause">Pause</option>
                    </select>
                  </label>}
                  {selectedLoop && <>
                    {activateLoop && <LoopAction label="Use loop" name={"Use saved loop on " + deck}
                      hint="Jump to Loop In and make this the current loop. Press Play if the deck is paused."
                      onClick={() => activateLoop(selected.time_seconds, selectedLoop.end_seconds)} />}
                    <LoopAction label={selectedLoop.active ? "Disarm loop" : "Arm loop"} pressed={selectedLoop.active}
                      disabled={!canArmLoop}
                      hint={selectedLoop.active ? "Turn off this saved loop’s automatic trigger. Use loop can jump to it on demand."
                        : canArmLoop ? "Engage automatically when playback reaches this loop. One loop can be armed per track, and the setting is saved."
                          : "Emergency loops need a late, steady range on the measured beat grid before they can be armed."}
                      onClick={() => {
                        if (session.selected === null) return
                        const armed = session.toggleLoopArmed(session.selected)
                        if (armed !== null) onLoopArmedChange?.(selected, armed)
                      }} />
                  </>}
                </div>}
              </form>
            )}
            {selected && !selected.metadata?.lead_in && <details className="deck-cue-lead">
              <summary>Lead-in</summary>
              <div className="deck-cue-lead-fields">
                <label>Length
                  <input type="number" min={0.001} max={600} step={unit === "seconds" ? "any" : 1}
                    value={amount} onChange={event => session.setLeadIn({ amount: event.target.value })} />
                </label>
                <label>Unit
                  <select value={unit} onChange={event => {
                    const next = event.currentTarget.value as LeadInUnit
                    const numeric = Number(amount)
                    session.setLeadIn({ unit: next, ...(next !== "seconds" && Number.isFinite(numeric)
                      && !Number.isInteger(numeric) && { amount: String(Math.round(numeric)) }) })
                  }}>
                    <option value="seconds">Seconds</option><option value="beats">Beats</option><option value="bars">Bars</option>
                  </select>
                </label>
                {unit !== "seconds" && <label title="Defaults to the deck’s playback tempo. Enter another BPM to match its audible beat length.">Lead-in BPM
                  <input type="number" min={20} max={400} step="any" value={tempoOverride}
                    placeholder={effectiveBpm !== null ? effectiveBpm.toFixed(1) : "Enter BPM"}
                    onChange={event => session.setLeadIn({ tempoOverride: event.currentTarget.value })} />
                </label>}
                {unit === "bars" && <label>Beats per bar
                  <input type="number" min={1} max={16} step={1} value={meter}
                    onChange={event => session.setLeadIn({ meter: event.currentTarget.value })} />
                </label>}
                <label>Order
                  <select value={leadInPlacement} onChange={event =>
                    onLeadInPlacementChange(event.currentTarget.value as LeadInPlacement)}>
                    <option value="insert">Before cue</option><option value="append">At end</option>
                  </select>
                </label>
              </div>
              <div className="deck-cue-actions">
                <button className="quiet" type="button" aria-label={"Mark lead-in on " + deck} disabled={leadPreview === null}
                  onClick={() => session.addLeadIn(unit, Number(amount), Number(meter), leadInPlacement, quantize, tempo, rate)}>Mark lead-in</button>
                {leadPreview !== null && <span className="time deck-cue-note" aria-label="Lead-in preview">
                  {formatTime(leadPreview, true)}
                </span>}
                {leadTooEarly && <span className="deck-cue-note">Lead-ins can start up to 10 minutes before the audio.</span>}
              </div>
            </details>}
          </div>
        </div>
      </>}
    </section>
  )
}
