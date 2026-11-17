import { useEffect, useMemo, useRef, useState } from "react"
import { appendAnalysisLoops, isGeneratedCue, mergeTrackAnalysis, sanitizeLoops } from "./analysisPreparation"
import { analyzeTrack } from "./analyzer"
import { manualBeatTicks, MIN_MANUAL_GRID_BPM, MAX_MANUAL_GRID_BPM, readBeatTimes, readManualBeatGrid, readModelBeatTimes } from "./beatGrid"
import { applyCueEdit } from "./cueEdit"
import type { CueEditPatch } from "./cueEdit"
import { cueIdentity, identifyCues, restoreCueEdits } from "./cuePreparation"
import { demoCues, readSidecar } from "./cues"
import type { Cue, Sidecar } from "./cues"
import { DEMO_BPM, DEMO_NAME } from "./demo"
import { estimateKey, formatKey } from "./key"
import type { TrackKey } from "./key"
import { leadInPlaybackRate, leadInTime, leadInTrackSeconds, placeLeadIn } from "./leadIn"
import type { LeadInPlacement, LeadInUnit } from "./leadIn"
import { studioLocalBackendAvailable } from "./localBackend"
import { queueLocalPreparation } from "./localPreparationQueue"
import { canArmEmergencyLoop, getLoop, suggestVocalLoopFromStem } from "./loops"
import { quantizeTime } from "./quantize"
import type { QuantizeMode } from "./quantize"
import { diagnosticError, recordDiagnostic } from "./studioDiagnostics"
import { defaultAnalysisPreferences } from "./studioPreferences"
import type { AnalysisPreferences } from "./studioPreferences"
import { readDeckKey, readDeckTempo } from "./trackAnalysisEvidence"
import { readTrackMetadata } from "./trackMetadata"
import { clampTrackTime } from "./trackTime"
import { readTrackPrep, subscribeTrackPrep, writeTrackPrep } from "./trackLibrary"
import type { WaveformData } from "./waveform"

export interface DeckCueTrack {
  name: string
  buffer: AudioBuffer
  file?: File
  demo?: boolean
  sidecar?: Sidecar
  libraryId?: string
}

type DeckCueStatus = "idle" | "queued" | "running" | "ready" | "error"
type CueEdit = { cues: Cue[]; selected: number | null }
type CueChange = { before: CueEdit; after: CueEdit }
type LeadInFields = { unit: LeadInUnit; amount: string; meter: string; tempoOverride: string }
type Snapshot = {
  owner: DeckCueTrack | null
  sidecar: Sidecar | null
  cues: Cue[]
  selected: number | null
  savedCues: Cue[]
  history: CueChange[]
  leadIn: LeadInFields
  suggested: Set<Cue>
  status: DeckCueStatus
  message: string
  tags: Awaited<ReturnType<typeof readTrackMetadata>> | null
  analyzedKey?: TrackKey | null
  stemBusy: boolean
  stemError: boolean
  stemMessage: string
  prepStatus: "idle" | "saving" | "saved" | "error"
}

const demoKey: TrackKey = { pitchClass: 0, mode: "minor", confidence: 1, method: "demo", analyzedWindows: 0 }

function originalName(track: DeckCueTrack): string {
  return track.file?.name ?? track.sidecar?.source_file ?? (track.demo ? DEMO_NAME : track.name)
}

function emptySnapshot(track: DeckCueTrack | null): Snapshot {
  const duration = track?.buffer.duration ?? 0
  const sidecar: Sidecar | null = track?.sidecar ?? (track?.demo ? {
    schema_version: 1,
    source_file: DEMO_NAME,
    analysis: {
      duration_seconds: duration,
      estimated_bpm: DEMO_BPM,
      studio_beatgrid: { status: "estimated", source: "generated_demo", beat_times_seconds: Array.from(
        // The generated kick drops out in the final bar.
        { length: Math.max(0, Math.ceil(Math.min(30, duration) * DEMO_BPM / 60)) },
        (_, index) => index * 60 / DEMO_BPM,
      ) },
    },
    cues: demoCues(duration),
    warnings: [],
  } : null)
  const cues = sidecar ? sanitizeLoops(identifyCues(sidecar.cues), duration, readBeatTimes(sidecar.analysis.studio_beatgrid, duration)) : []
  return {
    owner: track, sidecar, cues, selected: cues.length ? (track?.demo ? Math.min(1, cues.length - 1) : 0) : null,
    savedCues: cues, history: [], leadIn: { unit: "seconds", amount: "2", meter: "4", tempoOverride: "" },
    suggested: generatedCues(cues), status: sidecar ? "ready" : "idle", message: "", tags: null,
    stemBusy: false, stemError: false, stemMessage: "",
    prepStatus: track?.libraryId && sidecar ? "saved" : "idle",
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The cue operation could not be completed."
}

function recordEdit(snapshot: Snapshot, next: CueEdit): Snapshot {
  const { cues, selected } = snapshot
  const edited = next.cues.map(cue => cue.metadata?.studio_suggestion_key && !snapshot.suggested.has(cue)
    && !cue.metadata.studio_suggestion_edited
    ? { ...cue, metadata: { ...cue.metadata, studio_suggestion_edited: true } } : cue)
  const after = { ...next, cues: identifyCues(edited) }
  return { ...snapshot, ...after, history: [...snapshot.history.slice(-49), { before: { cues, selected }, after }] }
}

function preserveSelection(previous: CueEdit, cues: Cue[]): CueEdit {
  const selectedCue = previous.selected === null ? undefined : previous.cues[previous.selected]
  const id = cueIdentity(selectedCue)
  const match = selectedCue ? cues.findIndex(cue => cue === selectedCue
    || (id ? cueIdentity(cue) === id : cue.label === selectedCue.label && cue.time_seconds === selectedCue.time_seconds)) : -1
  return { cues, selected: cues.length ? (match < 0 ? Math.min(previous.selected ?? 0, cues.length - 1) : match) : null }
}

const generatedCues = (cues: Cue[]) => new Set(cues.filter(isGeneratedCue))

function deckKey(snapshot: Snapshot) {
  return snapshot.owner?.demo ? demoKey
    : readDeckKey(snapshot.sidecar?.analysis, snapshot.tags?.key ?? null, snapshot.analyzedKey)
}

function preparedSidecar(snapshot: Snapshot, track: DeckCueTrack): Sidecar {
  const analysis = snapshot.sidecar?.analysis
  const key = deckKey(snapshot)
  const hasGrid = readBeatTimes(analysis?.studio_beatgrid, track.buffer.duration).length >= 2
  const tempo = readDeckTempo(analysis, snapshot.tags?.bpm ?? null, hasGrid)
  return {
    ...snapshot.sidecar,
    schema_version: 1, source_file: originalName(track),
    analysis: {
      ...analysis, duration_seconds: track.buffer.duration, estimated_bpm: tempo.bpm,
      ...(tempo.source === "file_tag" && { estimated_bpm_source: "file_tag", estimated_bpm_confidence: undefined }),
      ...(key && {
        estimated_key: formatKey(key, "standard"), studio_key_source: key.method === "file-tag" ? "file_tag" : "audio",
      }),
    },
    cues: snapshot.cues,
    warnings: snapshot.sidecar?.warnings ?? [],
  }
}

export function useDeckCues(input: DeckCueTrack | null | undefined, waveform?: WaveformData | null,
  analysisPreferences: AnalysisPreferences = defaultAnalysisPreferences) {
  const track = input ?? null
  const latestPreferences = useRef(analysisPreferences)
  latestPreferences.current = analysisPreferences
  const initial = useMemo(() => emptySnapshot(track), [track])
  const [stored, setStored] = useState(initial)
  const latest = useRef(initial)
  const prepOrigin = useRef({})
  const prepVersion = useRef(0)
  const current = stored.owner === track ? stored : initial
  const owner = useRef(track)
  owner.current = track
  const pending = useRef<DeckCueTrack | null>(null)
  const stemTask = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const duration = track?.buffer.duration ?? 0
  const rawGrid = current.sidecar?.analysis.studio_beatgrid
  const observedBeatTimes = useMemo(() => readBeatTimes(rawGrid, duration), [rawGrid, duration])
  const rawManualGrid = current.sidecar?.analysis.studio_manual_grid
  const manualGrid = useMemo(() => readManualBeatGrid(rawManualGrid, duration), [rawManualGrid, duration])
  const beatTimes = useMemo(() => manualGrid ? manualBeatTicks(manualGrid, duration).map(beat => beat.time) : observedBeatTimes,
    [manualGrid, duration, observedBeatTimes])
  const prediction = current.sidecar?.analysis.studio_model_grid
  const predictedBeatTimes = useMemo(() => readModelBeatTimes(prediction, duration), [prediction, duration])
  const modelGrid = !manualGrid && observedBeatTimes.length < 2 && predictedBeatTimes.length >= 2
  const waveformBeatTimes = modelGrid ? predictedBeatTimes : beatTimes
  const detectedTempo = readDeckTempo(current.sidecar?.analysis, current.tags?.bpm ?? null, observedBeatTimes.length >= 2)
  const bpm = manualGrid?.bpm ?? detectedTempo.bpm
  const bpmSource = manualGrid ? "manual" : detectedTempo.source
  const key = deckKey(current)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (latest.current.owner !== track) commit(initial)
    const controller = new AbortController()
    const isCurrent = () => !controller.signal.aborted && owner.current === track
    async function readTrackEvidence() {
      if (!track || track.demo) return
      const tags = track.file ? await readTrackMetadata(track.file) : null
      if (!isCurrent()) return
      if (tags) edit(previous => ({ ...previous, tags }))
      if (tags?.key) return
      const analyzedKey = await estimateKey(track.buffer, controller.signal).catch(() => null)
      if (isCurrent()) edit(previous => ({ ...previous, analyzedKey }))
    }
    void readTrackEvidence()
    return () => controller.abort()
  }, [track, initial])

  useEffect(() => () => {
    stemTask.current?.abort()
    stemTask.current = null
  }, [track])

  function commit(snapshot: Snapshot) {
    latest.current = snapshot
    setStored(snapshot)
  }

  function edit(update: (snapshot: Snapshot) => Snapshot, autosave = false) {
    if (owner.current !== track) return
    const previous = latest.current.owner === track ? latest.current : initial
    const next = update(previous)
    if (next === previous) return
    if (!track?.libraryId || !autosave || (previous.cues === next.cues && previous.sidecar === next.sidecar)) {
      commit(next)
      return
    }
    const version = ++prepVersion.current
    const prep = preparedSidecar(next, track)
    commit({ ...next, savedCues: previous.savedCues, prepStatus: "saving" })
    void writeTrackPrep(track.libraryId, prep, prepOrigin.current).then(() => {
      if (!mounted.current || owner.current !== track || version !== prepVersion.current) return
      edit(snapshot => ({ ...snapshot, savedCues: next.cues, prepStatus: "saved" }))
    }).catch(cause => {
      recordDiagnostic("warn", "storage.cue_preparation.save_failed", diagnosticError(cause))
      if (!mounted.current || owner.current !== track || version !== prepVersion.current) return
      edit(snapshot => ({ ...snapshot, prepStatus: "error" }))
    })
  }

  useEffect(() => {
    if (!track?.libraryId) return
    let active = true
    let notified = false
    let delivered: Sidecar | undefined
    const version = prepVersion.current
    function receive(sidecar: Sidecar, origin?: object, status: "saving" | "saved" | "error" = "saved") {
      if (!active || owner.current !== track || origin === prepOrigin.current) return
      notified = true
      if (delivered === sidecar && status !== "saving") {
        edit(snapshot => ({ ...snapshot, savedCues: status === "saved" ? snapshot.cues : snapshot.savedCues, prepStatus: status }))
        return
      }
      delivered = sidecar
      prepVersion.current++
      edit(snapshot => {
        const grid = readBeatTimes(sidecar.analysis.studio_beatgrid, duration)
        const cues = sanitizeLoops(identifyCues(sidecar.cues), duration, grid)
        const previous = snapshot.sidecar
        const analysisChanged = !previous || JSON.stringify(previous.analysis) !== JSON.stringify(sidecar.analysis)
          || JSON.stringify(previous.warnings) !== JSON.stringify(sidecar.warnings)
        return {
          ...snapshot, ...preserveSelection(snapshot, cues), savedCues: status === "saved" ? cues : snapshot.savedCues,
          suggested: generatedCues(cues), sidecar: analysisChanged ? sidecar : previous, prepStatus: status,
        }
      })
    }
    const stop = subscribeTrackPrep(track.libraryId, receive)
    void readTrackPrep(track.libraryId).then(sidecar => {
      if (!notified && version === prepVersion.current && sidecar) receive(sidecar)
    }).catch(cause => recordDiagnostic("warn", "storage.cue_preparation.read_failed", diagnosticError(cause)))
    return () => { active = false; stop() }
  }, [track, duration])

  useEffect(() => {
    if (!track || !current.sidecar || !waveform || detectedTempo.bpm === null) return
    const sidecar = current.sidecar
    edit(snapshot => {
      if (snapshot.sidecar !== sidecar) return snapshot
      const prepared = appendAnalysisLoops({ ...sidecar, cues: snapshot.cues }, waveform, detectedTempo.bpm, duration, latestPreferences.current)
      const { cues } = prepared
      if (cues === snapshot.cues) return snapshot
      const additions = cues.slice(snapshot.cues.length)
      return {
        ...snapshot, cues, savedCues: snapshot.savedCues === snapshot.cues ? cues
          : sanitizeLoops(identifyCues([...snapshot.savedCues, ...additions]), duration, observedBeatTimes),
        suggested: generatedCues(cues),
        selected: snapshot.selected ?? 0,
      }
    }, true)
  }, [track, current.sidecar, waveform, detectedTempo.bpm, duration, observedBeatTimes])

  function analyze() {
    if (!track?.file || pending.current === track || !studioLocalBackendAvailable()) return
    const file = track.file
    const preferences = analysisPreferences
    pending.current = track
    edit(snapshot => ({ ...snapshot, status: "queued", message: "Waiting for local analysis…" }))
    const isCurrent = () => mounted.current && owner.current === track && pending.current === track
    void queueLocalPreparation(async () => {
      if (!isCurrent()) return
      const started = performance.now()
      recordDiagnostic("info", "analysis.started")
      edit(snapshot => ({ ...snapshot, status: "running", message: "Analyzing this deck…" }))
      try {
        const sidecar = await analyzeTrack(file, track.buffer, new AbortController().signal)
        recordDiagnostic("info", "analysis.finished", { elapsedMs: Math.round(performance.now() - started) })
        if (!isCurrent()) return
        edit(snapshot => {
          const previous = { analysis: snapshot.sidecar?.analysis ?? {}, cues: snapshot.cues }
          const { sidecar: merged, incomplete } = mergeTrackAnalysis(previous, sidecar, duration, preferences)
          const { analysis, cues } = merged
          const grid = readBeatTimes(analysis.studio_beatgrid, duration)
          const tempo = readDeckTempo(analysis, snapshot.tags?.bpm ?? null, grid.length >= 2)
          const savedCues = snapshot.savedCues === snapshot.cues ? cues
            : mergeTrackAnalysis({ ...previous, cues: snapshot.savedCues }, sidecar, duration, preferences).sidecar.cues
          return {
            ...snapshot, sidecar: merged, ...preserveSelection(snapshot, cues), suggested: generatedCues(cues),
            savedCues, status: "ready",
            message: readManualBeatGrid(analysis.studio_manual_grid, duration)
              ? "Analysis finished. Your manual beatgrid is still active."
              : grid.length < 2 && readModelBeatTimes(analysis.studio_model_grid, duration).length >= 2
              ? "Beat This predicted a grid for review. Beat positions are unverified."
              : grid.length < 2
              ? (tempo.bpm === null ? "No reliable pulse found."
                : tempo.source === "file_tag" ? "Showing BPM from file tags. Beat positions are unverified."
                  : "Tempo estimate available. Beat positions are unverified.")
                + (incomplete ? " Existing preparation was kept." : "")
              : incomplete ? "Analysis incomplete. Available results and existing preparation were kept."
              : sidecar.cues.length ? "Analysis ready." : "Analysis finished. No cue suggestions found.",
          }
        }, true)
      } catch (cause) {
        recordDiagnostic("error", "analysis.failed", { ...diagnosticError(cause), elapsedMs: Math.round(performance.now() - started) })
        if (isCurrent()) edit(snapshot => ({ ...snapshot, status: "error", message: errorMessage(cause) }))
      }
    }).finally(() => { if (pending.current === track) pending.current = null })
  }

  async function importCues(file: File) {
    if (!track || pending.current === track) return
    pending.current = track
    edit(snapshot => ({ ...snapshot, status: "queued", message: "Reading cue sidecar…" }))
    try {
      const sidecar = readSidecar(await file.text(), originalName(track), duration)
      if (owner.current !== track || !mounted.current) return
      edit(snapshot => {
        const currentGrid = snapshot.sidecar?.analysis.studio_beatgrid
        if (readBeatTimes(currentGrid, duration).length > 0) sidecar.analysis.studio_beatgrid = currentGrid
        const currentManual = readManualBeatGrid(snapshot.sidecar?.analysis.studio_manual_grid, duration)
        if (currentManual && !readManualBeatGrid(sidecar.analysis.studio_manual_grid, duration)) {
          sidecar.analysis.studio_manual_grid = currentManual
        }
        const currentPrediction = snapshot.sidecar?.analysis.studio_model_grid
        if (readModelBeatTimes(sidecar.analysis.studio_model_grid, duration).length < 2
          && readModelBeatTimes(currentPrediction, duration).length >= 2) sidecar.analysis.studio_model_grid = currentPrediction
        const currentImportedTempo = snapshot.sidecar?.analysis.studio_rekordbox_tempo
        const importedTempo = sidecar.analysis.studio_rekordbox_tempo
        if (!(Array.isArray(importedTempo) && importedTempo.length) && Array.isArray(currentImportedTempo) && currentImportedTempo.length) {
          sidecar.analysis.studio_rekordbox_tempo = currentImportedTempo
        }
        const reviewed = sidecar.cues.map(cue => isGeneratedCue(cue)
          ? { ...cue, metadata: { ...cue.metadata, studio_suggestion_edited: true } } : cue)
        const cues = sanitizeLoops(identifyCues(reviewed), duration, readBeatTimes(sidecar.analysis.studio_beatgrid, duration))
        return {
          ...snapshot, sidecar, cues, savedCues: cues, history: [], suggested: generatedCues(cues), selected: cues.length ? 0 : null,
          status: "ready", message: "Cue sidecar loaded.",
        }
      }, true)
    } catch (cause) {
      if (owner.current === track && mounted.current) edit(snapshot => ({ ...snapshot, status: "error", message: errorMessage(cause) }))
    } finally {
      if (pending.current === track) pending.current = null
    }
  }

  function saveManualGrid(anchor: number, tempo: number): string | null {
    if (!track || pending.current === track) return "Finish the current analysis or import first."
    if (!Number.isFinite(tempo) || tempo < MIN_MANUAL_GRID_BPM || tempo > MAX_MANUAL_GRID_BPM) {
      return `Enter a BPM between ${MIN_MANUAL_GRID_BPM} and ${MAX_MANUAL_GRID_BPM}.`
    }
    const manual = readManualBeatGrid({ version: 1, bpm: tempo, anchor_seconds: anchor }, duration)
    if (!manual) return "Choose a downbeat within the audio."
    edit(snapshot => {
      const sidecar = snapshot.sidecar ?? preparedSidecar(snapshot, track)
      return { ...snapshot, sidecar: { ...sidecar, analysis: { ...sidecar.analysis, studio_manual_grid: manual } },
        message: track.libraryId ? "Manual beatgrid applied." : "Manual beatgrid applied. Download JSON to keep it." }
    }, true)
    return null
  }

  function restoreAnalyzedGrid() {
    if (!track || pending.current === track) return
    edit(snapshot => {
      const sidecar = snapshot.sidecar
      if (!sidecar || !("studio_manual_grid" in sidecar.analysis)) return snapshot
      const { studio_manual_grid: _manual, ...analysis } = sidecar.analysis
      return { ...snapshot, sidecar: { ...sidecar, analysis }, message: "Manual beatgrid cleared." }
    }, true)
  }

  function downloadCues() {
    if (!track) return
    const name = originalName(track)
    const snapshot = latest.current.owner === track ? latest.current : current
    const sidecar = preparedSidecar(snapshot, track)
    const url = URL.createObjectURL(new Blob([JSON.stringify(sidecar, null, 2) + "\n"], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = name.replace(/\.[^.]+$/, "") + "-reviewed.magik-cue-genie.json"
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 5000)
    edit(previous => ({ ...previous, savedCues: snapshot.cues, message: "Cue sidecar downloaded.", status: "ready" }))
  }

  function select(index: number | null) {
    const id = index === null ? undefined : cueIdentity(current.cues[index])
    edit(snapshot => {
      const selected = id === undefined ? -1 : snapshot.cues.findIndex(cue => cueIdentity(cue) === id)
      return { ...snapshot, selected: selected < 0 ? null : selected }
    })
  }

  function undo() {
    edit(snapshot => {
      const change = snapshot.history.at(-1)
      if (!change) return snapshot
      const grid = readBeatTimes(snapshot.sidecar?.analysis.studio_beatgrid, duration)
      const cues = sanitizeLoops(restoreCueEdits(snapshot.cues, change.before.cues, change.after.cues), duration, grid)
      return {
        ...snapshot, ...preserveSelection(change.before, cues), suggested: generatedCues(cues), history: snapshot.history.slice(0, -1),
      }
    }, true)
  }

  function addCue(time: number, patch?: Partial<Cue>) {
    if (!track || !Number.isFinite(time)) return
    edit(snapshot => {
      const cue: Cue = {
        label: "Cue " + (snapshot.cues.length + 1), reason: "Placed in Cue Studio", confidence: 1, ...patch,
        metadata: { ...patch?.metadata, studio_id: crypto.randomUUID() },
        time_seconds: clampTrackTime(time, duration),
      }
      return recordEdit(snapshot, {
        cues: sanitizeLoops([...snapshot.cues, cue], duration, readBeatTimes(snapshot.sidecar?.analysis.studio_beatgrid, duration)),
        selected: snapshot.cues.length,
      })
    }, true)
  }

  function updateCue(index: number, patch: CueEditPatch): string | null {
    const id = cueIdentity(current.cues[index])
    const missing = "This cue is no longer selected."
    if (!id) return missing
    let error: string | null = missing
    edit(snapshot => {
      const from = snapshot.cues.find(cue => cueIdentity(cue) === id)
      if (!from) return snapshot
      const cue = applyCueEdit(from, patch, duration)
      error = typeof cue === "string" ? cue : null
      if (typeof cue === "string" || cue === from) return snapshot
      const grid = readBeatTimes(snapshot.sidecar?.analysis.studio_beatgrid, duration)
      const cues = sanitizeLoops(snapshot.cues.map(item => item === from ? cue : item), duration, grid)
      return recordEdit(snapshot, { cues, selected: snapshot.selected })
    }, true)
    return error
  }

  function removeCue(index: number) {
    const id = cueIdentity(current.cues[index])
    if (!id) return
    edit(snapshot => {
      const remove = snapshot.cues.findIndex(cue => cueIdentity(cue) === id)
      if (remove < 0) return snapshot
      const remaining = snapshot.cues.filter((cue, i) => i !== remove
        && (cue.metadata?.lead_in as { target_id?: string } | undefined)?.target_id !== id)
      return recordEdit(snapshot, preserveSelection(snapshot, remaining))
    }, true)
  }

  function canToggleLoop(index: number) {
    const cue = current.cues[index]
    const loop = cue && getLoop(cue, duration)
    return Boolean(loop && (loop.active || loop.kind !== "emergency" || canArmEmergencyLoop(cue, duration, observedBeatTimes)))
  }

  function toggleLoopArmed(index: number): boolean | null {
    const id = cueIdentity(current.cues[index])
    if (!id) return null
    const snapshot = latest.current.owner === track ? latest.current : current
    const cue = snapshot.cues.find(item => cueIdentity(item) === id)
    const loop = cue && getLoop(cue, duration)
    if (!loop || (!loop.active && loop.kind === "emergency"
      && !canArmEmergencyLoop(cue, duration, readBeatTimes(snapshot.sidecar?.analysis.studio_beatgrid, duration)))) return null
    const armed = !loop.active
    edit(snapshot => {
      if (!snapshot.cues.includes(cue)) return snapshot
      const cues = snapshot.cues.map(item => {
        const range = getLoop(item, duration)
        if (!range || (item !== cue && (!armed || !range.active))) return item
        return { ...item, metadata: { ...item.metadata,
          loop: { ...(item.metadata?.loop as Record<string, unknown>), active: item === cue && armed } } }
      })
      return recordEdit(snapshot, { cues, selected: snapshot.selected })
    }, true)
    return armed
  }

  function setLeadIn(patch: Partial<LeadInFields>) {
    edit(snapshot => ({ ...snapshot, leadIn: { ...snapshot.leadIn, ...patch } }))
  }

  function leadInOffset(unit: LeadInUnit, amount: number, meter: number, tempoOverride?: number, playbackRate = 1) {
    return leadInTrackSeconds(unit, amount, bpm, meter, playbackRate, tempoOverride)
  }

  function leadInPreview(unit: LeadInUnit, amount: number, meter: number, quantize: QuantizeMode,
    tempoOverride?: number, playbackRate = 1) {
    const offset = leadInOffset(unit, amount, meter, tempoOverride, playbackRate)
    const index = current.selected
    if (index === null) return null
    const cue = current.cues[index]
    const start = leadInTime(cue.time_seconds, offset)
    if (start === null) return null
    const overrideSetsDuration = unit !== "seconds" && tempoOverride !== undefined
    const time = overrideSetsDuration ? start : quantizeTime(start, beatTimes, quantize)
    return time < cue.time_seconds && !cue.metadata?.lead_in ? time : null
  }

  function addLeadIn(unit: LeadInUnit, amount: number, meter: number, placement: LeadInPlacement,
    quantize: QuantizeMode, tempoOverride?: number, playbackRate = 1) {
    const index = current.selected
    const time = leadInPreview(unit, amount, meter, quantize, tempoOverride, playbackRate)
    if (index === null || time === null) return false
    const cue = current.cues[index]
    const id = cueIdentity(cue) ?? crypto.randomUUID()
    edit(snapshot => {
      const targetIndex = snapshot.cues.findIndex(item => cueIdentity(item) === id)
      if (targetIndex < 0) return snapshot
      const previousIndex = snapshot.cues.findIndex(item =>
        (item.metadata?.lead_in as { target_id?: string } | undefined)?.target_id === id,
      )
      const leadIn: Cue = {
        label: previousIndex < 0 ? "Lead-in · " + cue.label : snapshot.cues[previousIndex].label,
        reason: "Lead-in for " + cue.label, time_seconds: time, confidence: 1,
        metadata: { studio_id: cueIdentity(snapshot.cues[previousIndex]) ?? crypto.randomUUID(), lead_in: {
          target_id: id, unit, amount, ...(unit !== "seconds" && {
            bpm: tempoOverride ?? (bpm === null ? null : bpm * leadInPlaybackRate(playbackRate)),
            playback_rate: leadInPlaybackRate(playbackRate),
          }),
          ...(unit === "bars" && { beats_per_bar: meter }) } },
      }
      const parent = snapshot.cues[targetIndex]
      const target = isGeneratedCue(parent)
        ? { ...parent, metadata: { ...parent.metadata, studio_suggestion_edited: true } } : parent
      return recordEdit(snapshot, placeLeadIn(snapshot.cues, targetIndex, target, leadIn, previousIndex, placement))
    }, true)
    return true
  }

  async function suggestFromStem(file: File) {
    if (!track || bpm === null || stemTask.current) return
    const beatsPerBar = Number(current.leadIn.meter)
    const meter = Number.isInteger(beatsPerBar) && beatsPerBar >= 1 && beatsPerBar <= 16 ? beatsPerBar : 4
    const controller = new AbortController()
    stemTask.current = controller
    edit(snapshot => ({ ...snapshot, stemBusy: true, stemError: false, stemMessage: "Reading isolated vocal stem…" }))
    const isCurrent = () => !controller.signal.aborted && mounted.current && owner.current === track
    try {
      const bytes = await file.arrayBuffer()
      if (!isCurrent()) return
      const decoder = new OfflineAudioContext(1, 1, track.buffer.sampleRate)
      const stem = await decoder.decodeAudioData(bytes)
      if (!isCurrent()) return
      if (Math.abs(stem.duration - duration) > 0.05) throw new Error("Choose an aligned vocal stem with the same length as the track.")
      const proposal = await suggestVocalLoopFromStem(stem, duration, bpm, meter, controller.signal)
      if (!isCurrent()) return
      edit(snapshot => {
        const duplicate = proposal && snapshot.cues.some(cue => getLoop(cue, duration)?.kind === "vocal"
          && Math.abs(cue.time_seconds - proposal.time_seconds) < 0.05)
        if (proposal && !duplicate) return {
          ...recordEdit(snapshot, { cues: [...snapshot.cues, proposal], selected: snapshot.cues.length }),
          stemBusy: false, stemMessage: "Vocal loop suggested · unarmed.",
        }
        return { ...snapshot, stemBusy: false, stemMessage: duplicate ? "This vocal loop is already saved." : "No suitable vocal-stem passage found." }
      }, true)
    } catch (cause) {
      if (isCurrent()) edit(snapshot => ({ ...snapshot, stemBusy: false, stemError: true, stemMessage: errorMessage(cause) }))
    } finally {
      if (stemTask.current === controller) stemTask.current = null
    }
  }

  return {
    ...current, beatTimes, observedBeatTimes, waveformBeatTimes, modelGrid, manualGrid, duration, bpm, bpmSource, key,
    dirty: current.cues.length !== current.savedCues.length || current.cues.some((cue, index) => cue !== current.savedCues[index]),
    canUndo: current.history.length > 0,
    keyPending: Boolean(track && !track.demo && current.analyzedKey === undefined),
    available: Boolean(track), canAnalyze: Boolean(track?.file) && studioLocalBackendAvailable(),
    analyze, importCues, downloadCues, select, addCue, updateCue, removeCue, addLeadIn, undo, suggestFromStem,
    canToggleLoop, toggleLoopArmed, setLeadIn, leadInOffset, leadInPreview, saveManualGrid, restoreAnalyzedGrid,
  }
}

export type DeckCueSession = ReturnType<typeof useDeckCues>
