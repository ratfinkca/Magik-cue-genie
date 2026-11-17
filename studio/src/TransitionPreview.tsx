import {
  ArrowCounterClockwiseIcon, FolderOpenIcon, PauseIcon, PlayIcon, SlidersHorizontalIcon, SparkleIcon,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode, RefObject } from "react"
import type { AuditionBehavior } from "./audio"
import type { Cue } from "./cues"
import { formatTime } from "./cues"
import { cueIdentity } from "./cuePreparation"
import Crossfader from "./Crossfader"
import { deckIds, EQ_BANDS, EQ_MIN_DB, EQ_MAX_DB, MASTER_MIN_DB, MASTER_MAX_DB, useTransitionAudio } from "./transitionAudio"
import type { DeckId, DeckLoop, EqBand, TransitionTrack } from "./transitionAudio"
import { useDeckCues } from "./deckCues"
import DeckCuePanel from "./DeckCuePanel"
import DeckLoopControls from "./DeckLoopControls"
import DeckPerformance, { pitchBounds } from "./DeckPerformance"
import type { PitchRange } from "./DeckPerformance"
import { StudioDiagnostics } from "./DiagnosticsPanel"
import { matchDeckSync, tapDeckSync } from "./deckSync"
import type { SyncResult, TapSyncState } from "./deckSync"
import { InstallStudio } from "./InstallStudio"
import type { KeyNotation } from "./key"
import type { LeadInPlacement } from "./leadIn"
import { LOCAL_BACKEND_REQUIRED, studioLocalBackendAvailable } from "./localBackend"
import { canArmEmergencyLoop, getLoop } from "./loops"
import { ChannelFxControls, MixerEffects, MixerMasterOut } from "./MixerExtras"
import { captureLoopEdge, makeBeatLoop, normalizePerformanceLoop, resizePerformanceLoop } from "./performanceLoop"
import { quantizeTime } from "./quantize"
import type { QuantizeMode } from "./quantize"
import EqKnob from "./EqKnob"
import { getChannelFilterFrequencies } from "./transitionEq"
import { CROSSFADER_CURVES, customCrossfaderWidth, GAIN_MAX_DB, GAIN_MIN_DB } from "./transitionMixer"
import type { CrossfaderCurve } from "./transitionMixer"
import TransitionWaveforms from "./TransitionWaveforms"
import TrackLibraryPanel from "./TrackLibraryPanel"
import StereoMeter, { useStudioMeters } from "./StereoMeter"
import { recordDiagnostic } from "./studioDiagnostics"
import StudioBackup from "./StudioBackup"
import StudioMidiPanel, { useMidiBindings } from "./StudioMidiPanel"
import { controllerPresets } from "./controllerPresets"
import type { MidiLearnTarget } from "./midiPreferences"
import { createStudioMidiRouter } from "./studioMidiRouting"
import { midiAxis, studioMidiTargets } from "./studioMidiTargets"
import StudioPreparationSettings from "./StudioPreparationSettings"
import { readStudioPreferences, writeStudioPreferences } from "./studioPreferences"
import type { WaveformData } from "./waveform"
import { useDeckSync } from "./useDeckSync"
import { useUsbMidi } from "./useUsbMidi"
import { MIN_TRACK_SECONDS } from "./trackTime"
import { deckFxTailSeconds } from "./transitionFx"
import type { HotCueMode } from "./hotCueGesture"
import type { DeckStem } from "./stemPlayback"
import "./transitionPreview.css"

type TransitionAudio = ReturnType<typeof useTransitionAudio>
type DeckWaveform = { buffer: AudioBuffer; data: WaveformData }
type SavedLoopEdit = {
  id: DeckId
  track: TransitionTrack
  cueId: string
  original: DeckLoop
  range: DeckLoop
  error?: string
}
const bandNames: Record<EqBand, string> = { low: "Low", mid: "Mid", high: "High" }
const stemControls: { id: DeckStem; label: string }[] = [
  { id: "vocals", label: "Vocals" }, { id: "drums", label: "Drums" },
  { id: "bass", label: "Bass" }, { id: "other", label: "Other" },
]
const quantizeModes: { value: QuantizeMode; label: string }[] = [
  { value: "off", label: "Off" }, { value: "beat", label: "1 beat" },
  { value: "half", label: "½ beat" }, { value: "quarter", label: "¼ beat" }, { value: "eighth", label: "⅛ beat" },
]
const quantizeKey = "magik.studio.quantize.v1"
const hotCueModeKey = "magik.studio.hotCueMode"
const hotCueModes: Record<HotCueMode, string> = { instant: "Play through", release: "Play on release", hold: "Hold to play" }
const dockModeKey = "magik.studio.dockMode"
const dockModes = ["library", "cues"] as const
type DockMode = typeof dockModes[number]

function storedPreference(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

function rememberPreference(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Storage is optional. */ }
}

function storedQuantize(): QuantizeMode {
  return quantizeModes.find(item => item.value === storedPreference(quantizeKey))?.value ?? "off"
}

function DeckSetup({ id, audio, dirty, activate, children }: {
  id: DeckId
  audio: TransitionAudio
  dirty: boolean
  activate: () => void
  children: ReactNode
}) {
  const { track, start, loading, error } = audio.decks[id]
  const input = useRef<HTMLInputElement>(null)
  const active = audio.playing[id] || audio.starting[id]
  const maxStart = track ? Math.max(0, Math.floor((track.buffer.duration - 1 / track.buffer.sampleRate) * 1000) / 1000) : 0
  const deck = "Deck " + id

  return (
    <section className="transition-deck" data-deck={id} aria-label={deck} onFocusCapture={activate}>
      <div className="transition-deck-top">
        <div className="transition-deck-track">
          <p className="transition-deck-badge">{deck}</p>
          <h3 title={track?.name}>{track?.name ?? (loading ? "Opening audio…" : "No audio loaded")}</h3>
        </div>
        <div className="transition-deck-tools">
          <button className="quiet transition-open" type="button" onClick={() => input.current?.click()}
            aria-label={"Open " + deck} title={"Open " + deck} disabled={loading}>
            <FolderOpenIcon aria-hidden="true" />
          </button>
        </div>
      </div>
      <input type="file" hidden ref={input} aria-label={"Audio file for " + deck}
        accept="audio/*,.aif,.aiff,.flac,.m4a,.mp3,.ogg,.wav"
        onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file && (!dirty || window.confirm("Replace " + deck + " and discard unsaved cue edits?"))) {
            void audio.loadFile(id, file)
          }
        }} />
      {(loading || error) && <p className="transition-note" data-error={Boolean(error)} role="status">{loading ? "Decoding audio…" : error}</p>}
      <div className="transition-deck-actions">
        {active
          ? <button className="deck-play" data-playing="true" type="button" aria-label={"Pause " + deck} onClick={() => audio.pause(id)}>
            <PauseIcon weight="fill" aria-hidden="true" /> Pause
          </button>
          : <button className="deck-play" type="button" aria-label={"Play " + deck}
            disabled={loading || !audio.canPlay(id)} onClick={() => void audio.play(id)}>
            <PlayIcon weight="fill" aria-hidden="true" /> Play
          </button>}
        <div className="transition-deck-fields">
          <label>Start (s)
            <input type="number" aria-label={deck + " start (seconds)"} min={MIN_TRACK_SECONDS} max={maxStart}
              step=".001" value={start} disabled={!track || active || loading}
              title="Negative positions play as silent pre-roll."
              onChange={event => audio.change(id, "start", event.target.value)} />
          </label>
        </div>
        {track && <p className="time transition-deck-time" aria-label={deck + " position"}>
          {formatTime(audio.positions[id], true)} <span>/ {formatTime(track.buffer.duration, true)}</span>
        </p>}
      </div>
      {children}
    </section>
  )
}

function MixerStems({ id, audio }: { id: DeckId; audio: TransitionAudio }) {
  if (!studioLocalBackendAvailable()) return null
  const { stemsStatus, stemLevels, stemsError, loading } = audio.decks[id]
  const label = "Deck " + id
  const busy = stemsStatus === "preparing" || stemsStatus === "restoring"
  const canPrepare = audio.canPrepareStems(id)

  return <div className="mixer-stem-controls" role="group" aria-label={label + " stems"}>
    {stemsStatus === "ready" ? <div className="mixer-stem-knobs">
      {stemControls.map(stem => <EqKnob key={stem.id} label={stem.label} name={label + " " + stem.label + " level"}
        value={stemLevels[stem.id]} min={0} max={100} resetValue={100} scale="linear" disabled={loading} reflectOnTap
        change={level => audio.setStemLevel(id, stem.id, level)}
        formatValue={level => level === 0 ? "Mute" : level + "%"}
        hint="Drag to change level. Click, tap, or press Space to invert the percentage. Home mutes and 0 restores full level." />)}
    </div> : busy ? <div className="mixer-stem-progress">
      <span role="status">{stemsStatus === "restoring" ? "Checking stem cache…" : "Separating stems…"}</span>
      <button type="button" className="quiet" onClick={() => audio.cancelStemPreparation(id)}
        aria-label={"Cancel stem loading on " + label}>Cancel</button>
    </div> : <button type="button" className="quiet" disabled={!canPrepare}
      aria-label={"Separate stems on " + label} onClick={() => void audio.prepareStems(id)}
      title={canPrepare ? "Separate vocals, drums, bass and other instruments locally" : "Stem separation supports tracks from 2 seconds to 6 minutes, depending on sample rate"}>
      Separate stems
    </button>}
    {stemsError && <p className="transition-note" data-error="true" role="status">{stemsError}</p>}
  </div>
}

function DeckMix({ id, audio, meterRef }: {
  id: DeckId
  audio: TransitionAudio
  meterRef: RefObject<HTMLDivElement | null>
}) {
  const deck = audio.decks[id]
  const label = "Deck " + id
  const disabled = !deck.track || deck.loading
  function filterLabel(value: number) {
    if (value === 0) return "Flat"
    const { lowpass, highpass } = getChannelFilterFrequencies(value, deck.track?.buffer.sampleRate ?? 48_000)
    const hz = value < 0 ? lowpass : highpass
    const frequency = hz >= 1_000 ? (hz / 1_000).toFixed(1) + "k" : Math.round(hz) + " Hz"
    return (value < 0 ? "LP " : "HP ") + frequency
  }
  return (
    <fieldset className="transition-eq-deck" data-deck={id} disabled={disabled} aria-label={label + " mixer"}>
      <legend>{label}</legend>
      <div className="transition-eq-knobs">
        <EqKnob label="Gain" name={label + " gain"} value={deck.gainDb} disabled={disabled}
          min={GAIN_MIN_DB} max={GAIN_MAX_DB} change={db => audio.setGain(id, db)} />
        <EqKnob label="Pan" name={label + " pan"} value={deck.pan} disabled={disabled}
          min={-100} max={100} change={value => audio.setPan(id, value)}
          formatValue={value => value === 0 ? "Center" : Math.abs(value) + (value < 0 ? " L" : " R")}
          hint="Turn left or right to pan. Double-click or press 0 to center." />
        <EqKnob label="Filter" name={label + " filter"} value={deck.filter} disabled={disabled}
          min={-100} max={100} change={value => audio.setFilter(id, value)} formatValue={filterLabel}
          hint="Turn left for low-pass and right for high-pass. Double-click or press 0 for flat." />
        {EQ_BANDS.map(band => <EqKnob key={band} label={bandNames[band]} name={label + " " + bandNames[band] + " EQ"}
          value={deck.eq[band]} disabled={disabled} change={value => audio.setEq(id, band, value)}
          resetGroup={() => audio.resetEq(id)} />)}
        <ChannelFxControls id={id} fx={deck.fx} disabled={disabled} onChange={patch => audio.setFx(id, patch)} />
      </div>
      {deck.track?.file && !deck.track.demo && <MixerStems id={id} audio={audio} />}
      <label className="channel-volume">Volume
        <input type="range" min="0" max="100" step="1" value={deck.volume} aria-label={label + " channel volume"}
          onChange={event => audio.setVolume(id, Number(event.currentTarget.value))}
          onDoubleClick={() => audio.setVolume(id, 100)} />
        <output>{deck.volume}%</output>
      </label>
      <div className="channel-meter">
        <StereoMeter label={label} meterRef={meterRef} title="Peak level after channel controls, before the crossfader." />
      </div>
    </fieldset>
  )
}

export default function TransitionPreview({ keyNotation, setKeyNotation }: {
  keyNotation: KeyNotation
  setKeyNotation: (notation: KeyNotation) => void
}) {
  const audio = useTransitionAudio()
  const [preparationPreferences, setPreparationPreferences] = useState(readStudioPreferences)
  const [dockMode, setDockMode] = useState<DockMode>(() => storedPreference(dockModeKey) === "cues" ? "cues" : "library")
  const dockTabs = useRef<Partial<Record<DockMode, HTMLButtonElement>>>({})
  function selectDock(mode: DockMode) {
    setDockMode(mode)
    rememberPreference(dockModeKey, mode)
  }
  const [waveforms, setWaveforms] = useState<Partial<Record<DeckId, DeckWaveform>>>({})
  const acceptWaveform = useCallback((id: DeckId, buffer: AudioBuffer, data: WaveformData) => {
    setWaveforms(previous => ({ ...previous, [id]: { buffer, data } }))
  }, [])
  const trackA = audio.decks.A.track
  const trackB = audio.decks.B.track
  const a = useDeckCues(trackA, waveforms.A?.buffer === trackA?.buffer ? waveforms.A?.data : undefined, preparationPreferences.analysis)
  const b = useDeckCues(trackB, waveforms.B?.buffer === trackB?.buffer ? waveforms.B?.data : undefined, preparationPreferences.analysis)
  const { saveTrackSidecar } = audio
  useEffect(() => {
    if (trackA && !trackA.libraryId && a.sidecar && a.sidecar !== trackA.sidecar) saveTrackSidecar("A", trackA, a.sidecar)
  }, [trackA, a.sidecar, saveTrackSidecar])
  useEffect(() => {
    if (trackB && !trackB.libraryId && b.sidecar && b.sidecar !== trackB.sidecar) saveTrackSidecar("B", trackB, b.sidecar)
  }, [trackB, b.sidecar, saveTrackSidecar])
  const sessions = { A: a, B: b }
  const [loopEdit, setLoopEdit] = useState<SavedLoopEdit | null>(null)
  const [capturedLoopIns, setCapturedLoopIns] = useState<Partial<Record<DeckId, { track: TransitionTrack; time: number }>>>({})
  useEffect(() => {
    setCapturedLoopIns(previous => {
      const A = previous.A?.track === trackA ? previous.A : undefined
      const B = previous.B?.track === trackB ? previous.B : undefined
      return A === previous.A && B === previous.B ? previous : { A, B }
    })
  }, [trackA, trackB])
  const loopEditBar = useRef<HTMLDivElement>(null)
  const editedCueIndex = loopEdit ? sessions[loopEdit.id].cues.findIndex(cue => cueIdentity(cue) === loopEdit.cueId) : -1
  const editedCue = loopEdit && editedCueIndex >= 0 ? sessions[loopEdit.id].cues[editedCueIndex] : null
  const activeLoopEdit = loopEdit && editedCue && editedCue.time_seconds === loopEdit.original.start
    && getLoop(editedCue, loopEdit.track.buffer.duration)?.end_seconds === loopEdit.original.end
    && audio.decks[loopEdit.id].track === loopEdit.track && !audio.decks[loopEdit.id].loading ? loopEdit : null
  const editingCueId = activeLoopEdit?.cueId
  const editingLoopDeck = activeLoopEdit?.id
  useEffect(() => {
    if (!editingCueId || !editingLoopDeck) return
    loopEditBar.current?.scrollIntoView({ block: "nearest" })
    loopEditBar.current?.focus({ preventScroll: true })
  }, [editingCueId, editingLoopDeck])
  useEffect(() => {
    if (loopEdit && !activeLoopEdit) setLoopEdit(null)
  }, [loopEdit, activeLoopEdit])
  const deckSync = useDeckSync({
    decks: {
      A: { track: trackA, bpm: a.bpm, speed: Number(audio.decks.A.speed), loading: audio.decks.A.loading },
      B: { track: trackB, bpm: b.bpm, speed: Number(audio.decks.B.speed), loading: audio.decks.B.loading },
    },
    setSpeed: audio.setSpeed,
  })
  const [cueDeck, setCueDeck] = useState<DeckId>("A")
  const [leadInPlacement, setLeadInPlacement] = useState<LeadInPlacement>(() =>
    storedPreference("magik.leadInPlacement") === "append" ? "append" : "insert")
  const [quantize, setQuantize] = useState<QuantizeMode>(storedQuantize)
  const [pitchRange, setPitchRange] = useState<PitchRange>(() => {
    const saved = storedPreference("magik.studio.pitchRange")
    return saved === "16" || saved === "wide" ? saved : "8"
  })
  const [auditionBehavior, setAuditionBehavior] = useState<AuditionBehavior>(() => {
    const saved = storedPreference("magik.auditionBehavior")
    return saved === "pause" || saved === "loop" ? saved : "continue"
  })
  const [hotCueMode, setHotCueMode] = useState<HotCueMode>(() => {
    const saved = storedPreference(hotCueModeKey)
    return saved === "release" || saved === "hold" ? saved : "instant"
  })
  const [syncReference, setSyncReference] = useState<"deck" | "tap">("deck")
  const [taps, setTaps] = useState<Partial<Record<DeckId, { track: TransitionTrack; tap: TapSyncState }>>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const playing = audio.playing.A || audio.playing.B || audio.starting.A || audio.starting.B
  const hasFxTail = deckIds.some(id => deckFxTailSeconds(audio.decks[id].fx) > 0)
  const meters = useStudioMeters(audio.getLevels, playing, hasFxTail)
  const playbackDetails = useRef<() => Record<string, string | number | boolean | null>>(() => ({}))
  playbackDetails.current = () => {
    const { A, B } = audio.decks
    const buffers = new Set([A.track?.buffer, B.track?.buffer])
    let pcmBytes = 0
    for (const buffer of buffers) {
      if (buffer) pcmBytes += buffer.length * buffer.numberOfChannels * 4
    }
    const heads = audio.getPositions()
    return {
      playingA: audio.playing.A, playingB: audio.playing.B,
      positionA: Math.round(heads.A * 10) / 10, positionB: Math.round(heads.B * 10) / 10,
      pcmMiB: Math.round(pcmBytes / (1024 * 1024)),
      keyLockA: A.keyLock, keyLockB: B.keyLock,
      effectA: A.fx.enabled && A.fx.mix > 0 ? A.fx.kind : null,
      effectB: B.fx.enabled && B.fx.mix > 0 ? B.fx.kind : null,
      visibility: document.visibilityState,
    }
  }
  const wasPlaying = useRef(false)
  useEffect(() => {
    const active = audio.playing.A || audio.playing.B
    if (active || wasPlaying.current) recordDiagnostic("info", "audio.playback.state", playbackDetails.current())
    wasPlaying.current = active
    if (!active) return
    const timer = window.setInterval(() => recordDiagnostic("info", "audio.playback.heartbeat", playbackDetails.current()), 20_000)
    return () => window.clearInterval(timer)
  }, [audio.playing.A, audio.playing.B])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timeout)
  }, [notice])
  const attemptedArms = useRef<Partial<Record<DeckId, { track: TransitionTrack; start: number; end: number }>>>({})
  const autoArm = useRef(() => {})
  autoArm.current = () => {
    for (const id of deckIds) {
      const { track, loopArmed } = audio.decks[id]
      const { cues, duration, observedBeatTimes } = sessions[id]
      const cue = cues.find(item => {
        const loop = getLoop(item, duration)
        return loop?.active
      })
      const attempted = attemptedArms.current[id]
      const loop = cue && getLoop(cue, duration)
      const range = cue && loop && (loop.kind !== "emergency" || canArmEmergencyLoop(cue, duration, observedBeatTimes))
        ? { start: cue.time_seconds, end: loop.end_seconds } : null
      if (!track || !range) {
        if (track && attempted?.track === track && loopArmed) audio.setLoop(id, null)
        delete attemptedArms.current[id]
        continue
      }
      if (attempted?.track === track) {
        if (attempted.start === range.start && attempted.end === range.end) continue
        if (loopArmed) audio.setLoop(id, null)
      }
      attemptedArms.current[id] = { track, ...range }
      audio.armLoop(id, range)
    }
  }
  useEffect(() => { autoArm.current() }, [trackA, trackB, a.cues, b.cues, a.observedBeatTimes, b.observedBeatTimes])
  const output = audio.playing.A && audio.playing.B ? "Playing both decks"
    : audio.playing.A ? "Deck A playing" : audio.playing.B ? "Deck B playing"
    : audio.starting.A || audio.starting.B ? "Starting playback…" : ""

  const canSync = (id: DeckId) => sessions[id].bpm !== null && sessions[id === "A" ? "B" : "A"].bpm !== null

  function syncState(id: DeckId, position: number) {
    const { bpm, beatTimes, duration } = sessions[id]
    return { bpm, position, speed: Number(audio.decks[id].speed), beats: beatTimes, duration }
  }

  function applySync(id: DeckId, result: SyncResult, reference: string) {
    if (!result.ok) {
      setNotice(result.reason === "speed-out-of-range" ? "This match is outside the supported pitch range."
        : "Set a reference and get a tempo for the track before syncing.")
      return false
    }
    const { loop, loopArmed } = audio.decks[id]
    const phase = result.position !== null && (!loop
      || (result.position < loop.end && (loopArmed || result.position >= loop.start))) ? result.position : undefined
    if (!audio.setSpeed(id, result.speed, phase)) return false
    const matched = "Deck " + id + " · " + result.effectiveBpm.toFixed(1) + " BPM"
    setNotice(matched + " from " + reference + (phase === undefined ? " · Tempo" : " · Tempo + phase"))
    return true
  }

  function currentTap(id: DeckId) {
    const previous = taps[id]
    return previous && previous.track === audio.decks[id].track ? previous.tap : null
  }

  function syncDeck(id: DeckId) {
    if (syncReference === "tap") {
      const track = audio.decks[id].track
      if (!track) return
      const { tap, result } = tapDeckSync(syncState(id, audio.getPositions()[id]), currentTap(id), performance.now())
      setTaps(previous => ({ ...previous, [id]: { track, tap } }))
      deckSync.release(id)
      if (result && (result.ok || result.reason !== "missing-tempo")) applySync(id, result, "Tap")
      return
    }
    if (deckSync.follower === id) {
      deckSync.release(id)
      setNotice("Deck " + id + " tempo follow released.")
    } else {
      const other = id === "A" ? "B" : "A"
      deckSync.sync(id, () => {
        const positions = audio.getPositions()
        return applySync(id, matchDeckSync(syncState(id, positions[id]), syncState(other, positions[other])), "Deck " + other)
      })
    }
  }

  function changeTempo(id: DeckId, tempo: number) {
    deckSync.release(id)
    audio.setSpeed(id, tempo)
  }

  function followStatus(id: DeckId) {
    if (deckSync.follower !== id) return undefined
    const leader = id === "A" ? "B" : "A"
    if (deckSync.followIssue === "speed-out-of-range") return "Deck " + leader + " is outside this deck’s tempo range."
    if (deckSync.followIssue === "missing-tempo") return "Waiting for both track tempos."
    return "Following Deck " + leader
  }

  function auditionCue(id: DeckId, cue: Cue, before: number) {
    const duration = sessions[id].duration
    const loop = getLoop(cue, duration)
    const start = Math.max(MIN_TRACK_SECONDS, cue.time_seconds - before)
    const end = Math.min(duration, loop?.end_seconds ?? cue.time_seconds + 3)
    void audio.audition(id, start, end, auditionBehavior, loop ? cue.time_seconds : start)
  }

  function selectDeckCue(id: DeckId, index: number) {
    const session = sessions[id]
    const cue = session.cues[index]
    if (!cue || audio.decks[id].loading || !audio.decks[id].track) return undefined
    setCueDeck(id)
    session.select(index)
    return cue
  }

  function triggerDeckHotCue(id: DeckId, index: number) {
    const cue = selectDeckCue(id, index)
    if (!cue) return
    audio.seek(id, cue.time_seconds)
    if (audio.canPlay(id)) void audio.play(id)
  }

  function pressDeckHotCue(id: DeckId, index: number, mode: Exclude<HotCueMode, "instant">) {
    const cue = selectDeckCue(id, index)
    return cue ? audio.pressHotCue(id, cue.time_seconds, mode) : undefined
  }

  function pressMidiAction(actionId: string) {
    const [id, action] = actionId.split(":")
    if (id !== "A" && id !== "B") return
    const deck = audio.decks[id]
    if (!deck.track || deck.loading) return
    setCueDeck(id)
    if (action.startsWith("hot-")) {
      const index = Number(action.slice(4)) - 1
      if (hotCueMode !== "instant") return pressDeckHotCue(id, index, hotCueMode)
      triggerDeckHotCue(id, index)
      return
    }
    switch (action) {
      case "play":
        if (audio.canPlay(id)) void audio.play(id)
        else audio.pause(id)
        return
      case "start-cue": {
        const start = Number(deck.start)
        if (Number.isFinite(start)) { audio.pause(id); audio.seek(id, start) }
        return
      }
      case "sync":
        if (syncReference === "tap" || canSync(id) || deckSync.follower === id) syncDeck(id)
        return
      case "key-lock":
        if (audio.keyLockAvailable && !deck.keyLockPending) void audio.setKeyLock(id, !deck.keyLock)
        return
      case "fx": audio.setFx(id, { enabled: !deck.fx.enabled }); return
      case "loop-exit":
        if (deck.loop) audio.setLoop(id, null)
        return
    }
    if (audio.starting[id]) return
    const { bpm, beatTimes } = sessions[id]
    const duration = deck.track.buffer.duration
    const position = audio.getPositions()[id]
    const pending = pendingLoopIn(id)
    const live = deck.loopArmed && deck.loop && position < deck.loop.start ? null : deck.loop
    if (action.startsWith("loop-saved-")) {
      const index = Number(action.slice(11)) - 1
      const saved = sessions[id].cues.map((cue, cueIndex) => ({ range: getLoop(cue, duration), cueIndex, start: cue.time_seconds }))
        .filter(item => item.range !== null)[index]
      if (saved?.range) {
        sessions[id].select(saved.cueIndex)
        const range = { start: saved.start, end: saved.range.end_seconds }
        if (live && Math.abs(live.start - range.start) < .001 && Math.abs(live.end - range.end) < .001) audio.setLoop(id, null)
        else audio.setLoop(id, range, true)
      }
      return
    }
    if (action === "loop-four" || action.startsWith("loop-size-")) {
      if (action === "loop-four" && live) { audio.setLoop(id, null); return }
      const beats = ([4, 8, 16, 32] as const).find(value => value === (action === "loop-four" ? 4 : Number(action.slice(10))))
      if (beats === undefined) return
      const range = makeBeatLoop(live?.start ?? pending ?? position, beats, beatTimes, bpm,
        live || pending !== null ? "off" : quantize, duration)?.range
      if (range) {
        if (live && Math.abs(live.start - range.start) < .001 && Math.abs(live.end - range.end) < .001) audio.setLoop(id, null)
        else if (audio.setLoop(id, range)) setPendingLoopIn(id, null)
      }
      return
    }
    if (action === "loop-in" || action === "loop-out") {
      const at = captureLoopEdge(position, beatTimes, quantize, duration)
      if (at === null) return
      if (action === "loop-in") setPendingLoopIn(id, at)
      else if (pending !== null) {
        const range = normalizePerformanceLoop(pending, at, duration)
        if (range && audio.setLoop(id, range, true)) setPendingLoopIn(id, null)
      }
      return
    }
    if (action !== "loop-half" && action !== "loop-double" && action !== "loop-beat") return
    const factor = action === "loop-half" ? .5 : action === "loop-double" ? 2 : 1
    const range = live && factor !== 1 ? resizePerformanceLoop(live, factor, duration)
      : makeBeatLoop(live?.start ?? pending ?? position, factor, beatTimes, bpm,
        live || pending !== null ? "off" : quantize, duration)?.range
    if (range && audio.setLoop(id, range)) setPendingLoopIn(id, null)
  }

  function getMidiAxis(actionId: string) {
    const [id, action] = actionId.split(":")
    if (id === "M") {
      if (action === "crossfader") return midiAxis(audio.fader, 0, 100, audio.setCrossfader, 50)
      if (action === "master") return midiAxis(audio.masterDb, MASTER_MIN_DB, MASTER_MAX_DB, audio.setMasterDb, 0)
      return null
    }
    if (id !== "A" && id !== "B") return null
    const deck = audio.decks[id]
    if (!deck.track || deck.loading) return null
    switch (action) {
      case "tempo": {
        const [min, max] = pitchBounds(pitchRange, 100)
        return midiAxis(Number(deck.speed), min, max, value => changeTempo(id, value), 100, .01)
      }
      case "gain": return midiAxis(deck.gainDb, GAIN_MIN_DB, GAIN_MAX_DB, value => audio.setGain(id, value), 0)
      case "volume": return midiAxis(deck.volume, 0, 100, value => audio.setVolume(id, value))
      case "pan": return midiAxis(deck.pan, -100, 100, value => audio.setPan(id, value), 0)
      case "filter": return midiAxis(deck.filter, -100, 100, value => audio.setFilter(id, value), 0)
      case "low": case "mid": case "high":
        return midiAxis(deck.eq[action], EQ_MIN_DB, EQ_MAX_DB, value => audio.setEq(id, action, value), 0)
      case "fx-mix": return midiAxis(deck.fx.mix, 0, 100, mix => audio.setFx(id, { mix }))
      case "vocals": case "drums": case "bass": case "other":
        return deck.stemsStatus === "ready" ? midiAxis(deck.stemLevels[action], 0, 100, value => audio.setStemLevel(id, action, value)) : null
      default: return null
    }
  }

  const [midiRouter] = useState(createStudioMidiRouter)
  const { bindings, presets, setBinding, removeBinding, applyPreset, autoApplyPresets, storageError } = useMidiBindings()
  const [midiLearning, setMidiLearning] = useState<MidiLearnTarget | null>(null)
  const midiLearnRef = useRef<MidiLearnTarget | null>(null)
  function learnMidi(target: MidiLearnTarget | null) {
    midiLearnRef.current = target
    setMidiLearning(target)
  }
  const usbMidi = useUsbMidi({
    onMessage: (input, bytes) => midiRouter.receive(input.id, bytes, {
      bindings, targets: studioMidiTargets, learning: midiLearnRef.current,
      preset: controllerPresets.find(preset => preset.id === presets.find(assignment => assignment.inputId === input.id)?.presetId),
      learned: binding => { learnMidi(null); setBinding(binding) },
      press: pressMidiAction, axis: getMidiAxis,
    }),
    onInputRemoved: inputId => {
      midiRouter.removeInput(inputId)
      if (midiLearnRef.current?.inputId === inputId) learnMidi(null)
    },
  })
  useLayoutEffect(() => { autoApplyPresets(usbMidi.inputs) }, [autoApplyPresets, usbMidi.inputs])
  useLayoutEffect(() => { midiRouter.updateBindings(bindings) }, [bindings, midiRouter])
  useLayoutEffect(() => { midiRouter.observeAxes(getMidiAxis) })
  useEffect(() => {
    window.addEventListener("pagehide", midiRouter.clear)
    return () => { window.removeEventListener("pagehide", midiRouter.clear); midiRouter.clear() }
  }, [midiRouter])

  const shortcutActions = useRef<(event: KeyboardEvent) => void>(() => {})
  shortcutActions.current = event => {
    if (event.repeat || !(event.target instanceof HTMLElement)
      || event.target.closest("input, textarea, select, button, summary, dialog, [role=slider], [contenteditable]")) return
    const session = sessions[cueDeck]
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey && session.canUndo) {
      event.preventDefault()
      session.undo()
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.code === "Space" && audio.decks[cueDeck].track) {
        event.preventDefault()
        if (audio.playing[cueDeck] || audio.starting[cueDeck]) audio.pause(cueDeck)
        else void audio.play(cueDeck)
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        const cue = session.cues[index]
        if (!cue) return
        session.select(index)
        auditionCue(cueDeck, cue, 2)
      }
    }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => shortcutActions.current(event)
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [])

  function pendingLoopIn(id: DeckId) {
    const captured = capturedLoopIns[id]
    const { track, loading } = audio.decks[id]
    return !loading && captured && captured.track === track ? captured.time : null
  }

  function setPendingLoopIn(id: DeckId, time: number | null) {
    const { track } = audio.decks[id]
    setCapturedLoopIns(previous => ({ ...previous, [id]: time === null || !track ? undefined : { track, time } }))
  }

  function createLoop(id: DeckId, from: number, to: number) {
    const session = sessions[id]
    const track = audio.decks[id].track
    if (!track) return
    if (activeLoopEdit?.id === id) return
    const bound = (time: number) => Math.max(0, Math.min(track.buffer.duration, time))
    const start = bound(quantizeTime(Math.min(from, to), session.beatTimes, quantize))
    const end = bound(quantizeTime(Math.max(from, to), session.beatTimes, quantize))
    setCueDeck(id)
    if (!audio.setLoop(id, { start, end })) {
      setNotice("Choose a longer loop or a finer quantize value.")
      return
    }
    setPendingLoopIn(id, null)
    setNotice("Deck " + id + " loop set.")
  }

  function editSavedLoop(id: DeckId, cue: Cue) {
    const { track, loading } = audio.decks[id]
    const cueId = cueIdentity(cue)
    const loop = track && getLoop(cue, track.buffer.duration)
    if (!track || loading || !cueId || !loop) return
    const range = { start: cue.time_seconds, end: loop.end_seconds }
    audio.pause(id)
    audio.seek(id, (range.start + range.end) / 2)
    setCueDeck(id)
    setLoopEdit({ id, track, cueId, original: range, range })
  }

  function trimWaveformLoop(id: DeckId, range: DeckLoop) {
    if (activeLoopEdit?.id === id) {
      setLoopEdit({ ...activeLoopEdit, range, error: undefined })
    } else if (audio.decks[id].loop && audio.setLoop(id, range)) setCueDeck(id)
  }

  function saveWaveformLoop(edit: SavedLoopEdit) {
    if (editedCueIndex < 0) return
    const error = sessions[edit.id].updateCue(editedCueIndex, {
      time_seconds: edit.range.start, loopEndSeconds: edit.range.end,
    })
    if (error) setLoopEdit({ ...edit, error })
    else {
      setLoopEdit(null)
      setNotice(`Deck ${edit.id} loop updated.`)
    }
  }

  function savedLoopIndex(id: DeckId, range: DeckLoop | null) {
    if (!range) return -1
    const session = sessions[id]
    return session.cues.findIndex(cue => {
      const saved = getLoop(cue, session.duration)
      return saved && cue.time_seconds === range.start && saved.end_seconds === range.end
    })
  }

  function saveLiveLoop(id: DeckId, range: DeckLoop) {
    const session = sessions[id]
    const index = savedLoopIndex(id, range)
    if (index >= 0) session.select(index)
    else {
      session.addCue(range.start, {
        label: "Loop",
        reason: "Saved from the deck loop controls.",
        metadata: { loop: { kind: "manual", end_seconds: range.end, active: false } },
      })
      setNotice("Deck " + id + " loop saved.")
    }
    setCueDeck(id)
  }

  function renderDeck(id: DeckId) {
    const tap = currentTap(id)
    const tapStatus = tap?.bpm != null
      ? tap.bpm.toFixed(1) + " BPM tapped" + (sessions[id].bpm === null ? " · Analyze track to sync" : "")
      : undefined
    return (
      <DeckSetup id={id} audio={audio} dirty={sessions[id].dirty}
        activate={() => setCueDeck(id)}>
        <DeckPerformance id={id} audio={audio} bpm={sessions[id].bpm}
          range={pitchRange} changeRange={range => {
            setPitchRange(range)
            rememberPreference("magik.studio.pitchRange", range)
          }} tapMode={syncReference === "tap"} tapStatus={tapStatus}
          syncLabel={deckSync.follower === id ? "Release tempo follow"
              : (deckSync.mode === "follow" ? "Follow Deck " : "Match Deck ") + (id === "A" ? "B" : "A")}
          followStatus={followStatus(id)} syncHeld={deckSync.follower === id}
          changeTempo={tempo => changeTempo(id, tempo)} syncAvailable={canSync(id)} sync={() => syncDeck(id)} />
        <DeckLoopControls id={id} audio={audio} bpm={sessions[id].bpm} beatTimes={sessions[id].beatTimes} quantize={quantize}
          pendingIn={pendingLoopIn(id)} setPendingIn={time => setPendingLoopIn(id, time)}
          saved={savedLoopIndex(id, audio.decks[id].loop) >= 0} saveLoop={range => saveLiveLoop(id, range)}
          exitLoop={() => audio.setLoop(id, null)} />
      </DeckSetup>
    )
  }

  return (
    <main className="workspace transition-workspace" aria-label="Cue Studio workspace">
        <h1 className="studio-title">Cue Studio</h1>
        <aside className="panel transition-sources" aria-label="Deck controls">
          <div className="transition-deck-header">
            <h2>Deck controls</h2>
            <button className="studio-demo" type="button" title="Load demo pair" aria-label="Load demo pair" disabled={playing}
              onClick={() => {
                if ((!a.dirty && !b.dirty) || window.confirm("Load the demo pair and discard unsaved cue edits?")) audio.loadDemo()
              }}><SparkleIcon weight="fill" aria-hidden="true" /></button>
          </div>
          {renderDeck("A")}
          <div className="transition-transport-group" role="group" aria-label="Deck transport">
            {playing
              ? <button className="quiet" type="button" onClick={() => audio.pause("both")}>
                <PauseIcon weight="fill" aria-hidden="true" /> Pause both
              </button>
              : <button className="quiet" type="button" disabled={!audio.canPlay("both")} onClick={() => void audio.play("both")}>
                <PlayIcon weight="fill" aria-hidden="true" /> Play both
              </button>}
            <button className="quiet" type="button" aria-label="Back to start cues" title="Back to start cues"
              disabled={!trackA && !trackB} onClick={() => audio.stop(false)}>
              <ArrowCounterClockwiseIcon aria-hidden="true" /> Start cues
            </button>
          </div>
          {renderDeck("B")}
          <section className="deck-settings" aria-labelledby="deck-settings-title">
            <h3 id="deck-settings-title">Deck settings</h3>
            <div className="board-options">
              <label>Sync mode
                <select value={deckSync.mode} onChange={event => deckSync.setMode(event.target.value === "follow" ? "follow" : "one-shot")}>
                  <option value="one-shot">One-shot</option>
                  <option value="follow">Follow tempo</option>
                </select>
              </label>
              <label>Sync reference
                <select value={syncReference} onChange={event => {
                  setSyncReference(event.target.value === "tap" ? "tap" : "deck")
                  setTaps({})
                }}>
                  <option value="deck">Other deck</option>
                  <option value="tap">Tap tempo</option>
                </select>
              </label>
              <label className="hot-cue-setting" title="Play through keeps playing, Play on release parks the deck until release, and Hold to play returns to the paused cue when released.">
                Hot cues
                <select value={hotCueMode} onChange={event => {
                  const mode = event.currentTarget.value as HotCueMode
                  setHotCueMode(mode)
                  rememberPreference(hotCueModeKey, mode)
                }}>
                  {Object.entries(hotCueModes).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
                </select>
              </label>
            </div>
          </section>
        </aside>

        <TransitionWaveforms
          tracks={{ A: audio.decks.A.track?.buffer, B: audio.decks.B.track?.buffer }}
          names={{ A: audio.decks.A.track?.name, B: audio.decks.B.track?.name }}
          positions={audio.positions}
          speeds={{ A: Number(audio.decks.A.speed), B: Number(audio.decks.B.speed) }}
          isPlaying={audio.playing.A || audio.playing.B}
          getPositions={audio.getPositions}
          seek={(id, seconds) => { setCueDeck(id); audio.seek(id, seconds) }}
          beginScrub={(id, seconds) => { setCueDeck(id); return audio.beginScrub(id, seconds) }}
          updateScrub={audio.updateScrub}
          endScrub={audio.endScrub}
          cues={{ A: a.cues, B: b.cues }}
          cueColors={preparationPreferences.cueColors}
          beatTimes={{ A: a.waveformBeatTimes, B: b.waveformBeatTimes }}
          predictedBeatGrid={{ A: a.modelGrid, B: b.modelGrid }}
          manualBeatGrid={{ A: a.manualGrid, B: b.manualGrid }}
          bpm={{ A: a.bpm, B: b.bpm }}
          onWaveformReady={acceptWaveform}
          loops={{ A: activeLoopEdit?.id === "A" ? activeLoopEdit.range : audio.decks.A.loop,
            B: activeLoopEdit?.id === "B" ? activeLoopEdit.range : audio.decks.B.loop }}
          selectedCues={{ A: a.selected, B: b.selected }}
          selectCue={(id, index) => {
            const cue = selectDeckCue(id, index)
            if (cue) audio.seek(id, cue.time_seconds)
          }}
          hotCueMode={hotCueMode}
          triggerCue={triggerDeckHotCue}
          pressCue={pressDeckHotCue}
          createLoop={createLoop}
          trimLoop={trimWaveformLoop}
          loopQuantize={quantize}
          loopBeatTimes={{ A: a.beatTimes, B: b.beatTimes }}
          pendingLoopIns={{ A: editingLoopDeck === "A" ? null : pendingLoopIn("A"),
            B: editingLoopDeck === "B" ? null : pendingLoopIn("B") }}
          loopEditor={activeLoopEdit && editedCue && <div className="wave-loop-editor" tabIndex={-1}
            ref={loopEditBar} role="group" aria-label={`Edit Deck ${activeLoopEdit.id} saved loop`}>
            <strong>Deck {activeLoopEdit.id} · {editedCue.label}</strong>
            <span>Drag In, Out, or Move. Hold Shift to bypass Quantize.</span>
            <button className="quiet" type="button" onClick={() => saveWaveformLoop(activeLoopEdit)}
              disabled={activeLoopEdit.range.start === activeLoopEdit.original.start
                && activeLoopEdit.range.end === activeLoopEdit.original.end}>Save changes</button>
            <button className="quiet" type="button" onClick={() => setLoopEdit(null)}>Cancel</button>
            {activeLoopEdit.error && <span role="alert">{activeLoopEdit.error}</span>}
          </div>}
          eq={{ A: audio.decks.A.eq, B: audio.decks.B.eq }}
          gainDb={{ A: audio.decks.A.gainDb, B: audio.decks.B.gainDb }}
          filter={{ A: audio.decks.A.filter, B: audio.decks.B.filter }}
          toolbar={<div className="wave-session-controls">
            <div className="studio-preferences" role="group" aria-label="Session preferences">
              <label title="Snaps cue and loop placement on observed beat grids.">
                Quantize
                <select value={quantize} onChange={event => {
                  const mode = quantizeModes.find(item => item.value === event.target.value)?.value ?? "off"
                  setQuantize(mode)
                  rememberPreference(quantizeKey, mode)
                }}>{quantizeModes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
              </label>
              <label title="Sets how track keys are displayed.">
                Key format
                <select value={keyNotation} onChange={event => setKeyNotation(event.target.value as KeyNotation)}>
                  <option value="standard">Standard</option>
                  <option value="camelot">Camelot</option>
                  <option value="open">Open Key</option>
                </select>
              </label>
            </div>
            <div className="session-status wave-session-status" role="status" data-error={Boolean(audio.error)}>
              {audio.error ?? notice ?? (output || audio.restoreNotice || (audio.restoreStatus === "restoring" ? "Restoring decks…" : ""))}
            </div>
          </div>}
        />

        <aside className="panel transition-mixer" aria-label="Mixer">
          <div className="mixer-header">
            <h2>Mixer</h2>
            <MixerMasterOut value={audio.masterDb} onChange={audio.setMasterDb} meterRef={meters.master} />
            <details className="mixer-curve-settings" onKeyDown={event => {
              if (event.key !== "Escape" || !event.currentTarget.open) return
              event.currentTarget.open = false
              event.currentTarget.querySelector("summary")?.focus()
            }}>
              <summary className="quiet" title="Crossfader curve settings" aria-label="Crossfader curve settings">
                <SlidersHorizontalIcon aria-hidden="true" />
              </summary>
              <div className="mixer-curve-popover">
                <label className="mixer-curve">Curve
                  <select aria-label="Crossfader curve" value={audio.curve}
                    onChange={event => audio.setCurve(event.target.value as CrossfaderCurve)}>
                    {Object.entries(CROSSFADER_CURVES).map(([id, option]) => <option value={id} key={id}>{option.label}</option>)}
                  </select>
                </label>
                {audio.curve === "custom" && <div className="mixer-curve-controls">
                  <label title="How far from a muted end the channel reaches full level.">
                    <span>Cut-in <output>{customCrossfaderWidth(audio.customCurve)}%</output></span>
                    <input type="range" min={0} max={100} step={1} value={audio.customCurve.cut}
                      aria-label="Crossfader cut-in" aria-valuetext={customCrossfaderWidth(audio.customCurve) + "% to open"}
                      onChange={event => audio.setCustomCurve({ ...audio.customCurve, cut: event.currentTarget.valueAsNumber })} />
                  </label>
                  <label title="Blend a straight ramp into a power curve.">
                    <span>Softening <output>{audio.customCurve.softness}%</output></span>
                    <input type="range" min={0} max={100} step={1} value={audio.customCurve.softness}
                      aria-label="Crossfader softening"
                      onChange={event => audio.setCustomCurve({ ...audio.customCurve, softness: event.currentTarget.valueAsNumber })} />
                  </label>
                </div>}
              </div>
            </details>
          </div>
          {deckIds.map(id => <DeckMix key={id} id={id} audio={audio} meterRef={meters[id]} />)}
          <Crossfader position={audio.fader} curve={audio.curve} custom={audio.customCurve} change={audio.setCrossfader} />
          <div className="mixer-bottom">
            <MixerEffects fx={{ A: audio.decks.A.fx, B: audio.decks.B.fx }} onChange={audio.setFx}
              bpm={{
                A: a.bpm === null ? null : a.bpm * Number(audio.decks.A.speed) / 100,
                B: b.bpm === null ? null : b.bpm * Number(audio.decks.B.speed) / 100,
              }} />
          </div>
        </aside>

        <section className="panel deck-cue-dock" aria-label="Track preparation">
          <div className="session-editor-toolbar">
            <div className="segments session-editor-tabs" role="tablist" aria-label="Track preparation view">
              {dockModes.map(mode => <button key={mode} id={"studio-" + mode + "-tab"} role="tab" type="button"
                aria-controls={"studio-" + mode + "-panel"} aria-selected={dockMode === mode}
                tabIndex={dockMode === mode ? 0 : -1} ref={element => { if (element) dockTabs.current[mode] = element }}
                onClick={() => selectDock(mode)} onKeyDown={event => {
                  const next = event.key === "Home" ? "library" : event.key === "End" ? "cues"
                    : event.key === "ArrowLeft" || event.key === "ArrowRight" ? mode === "library" ? "cues" : "library" : null
                  if (!next) return
                  event.preventDefault()
                  selectDock(next)
                  dockTabs.current[next]?.focus()
                }}>{mode === "library" ? "Library" : "Cue points"}</button>)}
            </div>
            <div className="session-utilities" role="group" aria-label="Studio utilities">
              <StudioMidiPanel midi={{ ...usbMidi, connect: () => {
                void audio.prepareControllerPlayback()
                return usbMidi.connect()
              } }} targets={studioMidiTargets} bindings={bindings} presets={presets} applyPreset={applyPreset}
                learning={midiLearning} learn={learnMidi} remove={removeBinding} setBinding={setBinding} storageError={storageError} />
              <StudioPreparationSettings preferences={preparationPreferences} change={preferences => {
                setPreparationPreferences(preferences)
                writeStudioPreferences(preferences)
              }} />
              <StudioBackup />
              <InstallStudio />
              <StudioDiagnostics forgetDecks={audio.clearSavedTracks} />
            </div>
          </div>
          {!studioLocalBackendAvailable() && <p className="studio-hosted-note">
            Your audio stays on this device. {LOCAL_BACKEND_REQUIRED}{" "}
            <a href="https://github.com/ratfinkca/Magik-cue-genie/blob/main/docs/cue-studio.md">Local setup</a>
          </p>}
          <div id="studio-library-panel" role="tabpanel" aria-labelledby="studio-library-tab" hidden={dockMode !== "library"}>
            <TrackLibraryPanel tracks={audio.library} status={audio.libraryStatus} notice={audio.libraryNotice}
              decodeForPreparation={audio.decodeForPreparation}
              loaded={{ A: trackA?.libraryId, B: trackB?.libraryId }}
              busyDecks={{ A: audio.decks.A.loading, B: audio.decks.B.loading }}
              addTracks={audio.addLibraryTracks} loadTrack={async (id, libraryId) => {
                if (sessions[id].dirty && !window.confirm("Replace Deck " + id + " with unsaved cue edits?")) return false
                const loaded = await audio.loadLibraryTrack(id, libraryId)
                if (loaded) setCueDeck(id)
                return loaded
              }} removeTrack={audio.removeLibraryTrack} />
          </div>
          <div id="studio-cues-panel" role="tabpanel" aria-labelledby="studio-cues-tab" hidden={dockMode !== "cues"}>
          <div className="deck-cue-grid">
            {deckIds.map(id => <div key={id} data-active={cueDeck === id} onFocusCapture={() => setCueDeck(id)}>
              <DeckCuePanel deckId={id} session={sessions[id]} position={audio.positions[id]} playbackRate={Number(audio.decks[id].speed) / 100}
                cueColors={preparationPreferences.cueColors}
                getPosition={() => audio.getPositions()[id]}
                seek={seconds => audio.seek(id, seconds)} quantize={quantize} keyNotation={keyNotation}
                activateLoop={(start, end) => { audio.setLoop(id, { start, end }, true) }}
                onTrimLoop={cue => editSavedLoop(id, cue)}
                audition={(cue, before) => auditionCue(id, cue, before)}
                leadInPlacement={leadInPlacement} onLeadInPlacementChange={placement => {
                  setLeadInPlacement(placement)
                  rememberPreference("magik.leadInPlacement", placement)
                }}
                auditionBehavior={auditionBehavior} onAuditionBehaviorChange={behavior => {
                  setAuditionBehavior(behavior)
                  rememberPreference("magik.auditionBehavior", behavior)
                }} />
            </div>)}
          </div>
          </div>
        </section>
    </main>
  )
}
