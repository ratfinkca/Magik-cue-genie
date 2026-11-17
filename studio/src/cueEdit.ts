import { normalizeCueColor } from "./cues"
import type { Cue } from "./cues"
import { getLoop } from "./loops"
import { clampTrackTime } from "./trackTime"

export type CueEditPatch = { label?: string; time_seconds?: number; loopEndSeconds?: number; color?: string | null }

/** Apply the inspector's draft together, or return a message without changing the cue. */
export function applyCueEdit(cue: Cue, patch: CueEditPatch, duration: number): Cue | string {
  const label = patch.label?.trim() ?? cue.label
  if (!label) return "Enter a cue name."
  const seconds = patch.time_seconds ?? cue.time_seconds
  if (!Number.isFinite(seconds)) return "Enter a valid cue time."
  const loop = getLoop(cue, duration)
  if (patch.loopEndSeconds !== undefined && !loop) return "Select a saved loop to edit its end."
  const time = loop ? seconds : clampTrackTime(seconds, duration)
  const end = patch.loopEndSeconds ?? loop?.end_seconds
  const changesBounds = loop && (time !== cue.time_seconds || end !== loop.end_seconds)
  if (changesBounds && (end === undefined || !Number.isFinite(end) || time < 0 || end > duration || end < time + .05)) {
    return "Keep the loop inside the audio and at least 0.05 seconds long."
  }
  const color = normalizeCueColor(patch.color)
  if (patch.color !== undefined && patch.color !== null && !color) return "Choose a valid cue color."
  const changesColor = patch.color !== undefined && cue.metadata?.color !== color
  if (!changesBounds && !changesColor && time === cue.time_seconds && label === cue.label) return cue
  let metadata = cue.metadata
  if (changesBounds || changesColor) {
    metadata = { ...metadata }
    if (changesBounds) {
      metadata.loop = { ...(cue.metadata?.loop as Record<string, unknown>), start_seconds: time, end_seconds: end }
    }
    if (changesColor) {
      if (color) metadata.color = color
      else delete metadata.color
    }
  }
  return { ...cue, label, time_seconds: time, metadata }
}
