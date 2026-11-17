import { readBeatTimes, readManualBeatGrid, readModelBeatTimes } from "./beatGrid"
import { identifyCues } from "./cuePreparation"
import type { Cue, Sidecar } from "./cues"
import { canArmEmergencyLoop, getLoop, suggestEmergencyLoop, suggestVocalLoop } from "./loops"
import { usableBpm } from "./trackAnalysisEvidence"
import { parseTaggedKey } from "./trackMetadata"
import type { AnalysisPreferences } from "./studioPreferences"
import type { WaveformData } from "./waveform"

export function sanitizeLoops(cues: Cue[], duration: number, beatTimes: readonly number[]): Cue[] {
  let locked = false
  return cues.map(cue => {
    if (cue.time_seconds < 0 && cue.metadata?.loop !== undefined) {
      const { loop: _unsupported, ...metadata } = cue.metadata
      return { ...cue, metadata }
    }
    const loop = getLoop(cue, duration)
    if (!loop?.active) return cue
    if (!locked && (loop.kind !== "emergency" || canArmEmergencyLoop(cue, duration, beatTimes))) {
      locked = true
      return cue
    }
    return withoutAutoTrigger(cue)
  })
}

function withoutAutoTrigger(cue: Cue): Cue {
  return { ...cue, metadata: { ...cue.metadata, loop: { ...(cue.metadata?.loop as Record<string, unknown>), active: false } } }
}

export function isGeneratedCue(cue: Cue) {
  return Boolean(cue.metadata?.studio_suggestion_key && !cue.metadata.studio_suggestion_edited)
}

function stageStatus(value: unknown) {
  return value && typeof value === "object" && "status" in value ? value.status : undefined
}

function markSuggestion(cue: Cue, idPrefix: string): Cue {
  const key = cue.label + ":" + Math.round(cue.time_seconds * 1000)
  return { ...cue, metadata: { ...cue.metadata, studio_suggestion_key: key, studio_id: idPrefix + ":" + key } }
}

/** Keep manual edits and any prior observed grid that an incomplete reanalysis cannot replace. */
export function mergeTrackAnalysis(previous: Pick<Sidecar, "analysis" | "cues"> | null, result: Sidecar, duration: number,
  preferences: AnalysisPreferences): { sidecar: Sidecar; incomplete: boolean } {
  const analysis = { ...result.analysis }
  const old = previous?.analysis
  if (old) {
    const manual = readManualBeatGrid(old.studio_manual_grid, duration)
    if (manual) analysis.studio_manual_grid = manual
    if (!(Array.isArray(analysis.studio_rekordbox_tempo) && analysis.studio_rekordbox_tempo.length)
      && Array.isArray(old.studio_rekordbox_tempo) && old.studio_rekordbox_tempo.length) {
      analysis.studio_rekordbox_tempo = old.studio_rekordbox_tempo
    }
    const missingGrid = readBeatTimes(analysis.studio_beatgrid, duration).length < 2
    const retainedGrid = missingGrid && readBeatTimes(old.studio_beatgrid, duration).length >= 2
    if ((!usableBpm(analysis.estimated_bpm) || retainedGrid) && usableBpm(old.estimated_bpm)) {
      analysis.estimated_bpm = old.estimated_bpm
      analysis.estimated_bpm_source = old.estimated_bpm_source
      analysis.estimated_bpm_confidence = old.estimated_bpm_confidence
    }
    if (retainedGrid) analysis.studio_beatgrid = old.studio_beatgrid
    if (readModelBeatTimes(analysis.studio_model_grid, duration).length < 2
      && readModelBeatTimes(old.studio_model_grid, duration).length >= 2) analysis.studio_model_grid = old.studio_model_grid
    if (!parseTaggedKey(analysis.estimated_key) && parseTaggedKey(old.estimated_key)) {
      analysis.estimated_key = old.estimated_key
      analysis.studio_key_source = old.studio_key_source
    }
  }
  const cueStage = stageStatus(analysis.studio_cues)
  const partial = cueStage !== undefined && cueStage !== "ready"
  const incomplete = partial || [result.analysis.studio_base, result.analysis.studio_tempo, result.analysis.studio_beatgrid]
    .some(stage => stageStatus(stage) === "error")
  const kept = (previous?.cues ?? []).filter(cue => partial || !isGeneratedCue(cue))
  const suggestions = result.cues.flatMap((cue, index) => {
    const loop = getLoop(cue, duration)
    if (cue.confidence < preferences.minimumConfidence || (loop?.kind === "vocal" && !preferences.vocalLoops)
      || (loop?.kind === "emergency" && preferences.emergencyLoops === "off")) return []
    const suggestion = loop?.active && (loop.kind === "vocal" || (loop.kind === "emergency" && preferences.emergencyLoops === "suggest"))
      ? withoutAutoTrigger(cue) : cue
    return [markSuggestion(suggestion, "analyzed:" + index)]
  }).filter(cue => !kept.some(existing => existing.metadata?.studio_suggestion_key === cue.metadata?.studio_suggestion_key
    || (existing.label === cue.label && Math.abs(existing.time_seconds - cue.time_seconds) < .001)))
  const grid = readBeatTimes(analysis.studio_beatgrid, duration)
  const cues = sanitizeLoops(identifyCues([...kept, ...suggestions]), duration, grid)
  return { sidecar: { ...result, analysis, cues }, incomplete }
}

export function appendAnalysisLoops(sidecar: Sidecar, waveform: WaveformData | null | undefined, bpm: number | null,
  duration: number, preferences: AnalysisPreferences): Sidecar {
  const grid = readBeatTimes(sidecar.analysis.studio_beatgrid, duration)
  const additions: Cue[] = []
  if (preferences.emergencyLoops !== "off") {
    const emergency = suggestEmergencyLoop(sidecar.cues, bpm, waveform ?? null, duration, 4, grid)
    if (emergency && emergency.confidence >= preferences.minimumConfidence && canArmEmergencyLoop(emergency, duration, grid)) {
      const shouldArm = preferences.emergencyLoops === "arm" && !sidecar.cues.some(cue => getLoop(cue, duration)?.active)
      additions.push(shouldArm ? emergency : withoutAutoTrigger(emergency))
    }
  }
  if (preferences.vocalLoops) {
    const vocal = suggestVocalLoop(sidecar.cues, bpm, duration)
    if (vocal && vocal.confidence >= preferences.minimumConfidence) additions.push(vocal)
  }
  if (!additions.length) return sidecar
  const cues = identifyCues([...sidecar.cues, ...additions.map(cue => markSuggestion(cue, "suggested-loop"))])
  return { ...sidecar, cues: sanitizeLoops(cues, duration, grid) }
}
