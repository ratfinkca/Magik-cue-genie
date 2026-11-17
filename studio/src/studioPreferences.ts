import { cueColor, normalizeCueColor } from "./cues"
import type { Cue } from "./cues"

export const cueColorNames = ["Mix in", "Mix out", "First pulse", "First drop", "Energy rises", "Energy falls",
  "Vocal loop", "Emergency loop"] as const
export type CueColorName = typeof cueColorNames[number]
export type CueColors = Partial<Record<CueColorName, string>>
export type AnalysisPreferences = {
  minimumConfidence: 0 | .5 | .6
  vocalLoops: boolean
  emergencyLoops: "off" | "suggest" | "arm"
}
export type StudioPreferences = { cueColors: CueColors; analysis: AnalysisPreferences }

const preferencesKey = "magik.studio.preparation.v1"
export const defaultAnalysisPreferences: AnalysisPreferences = { minimumConfidence: 0, vocalLoops: true, emergencyLoops: "arm" }

function knownFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseStudioPreferences(value: unknown): StudioPreferences {
  const stored = knownFields(value)
  const savedColors = knownFields(stored.cueColors)
  const cueColors: CueColors = {}
  for (const name of cueColorNames) {
    const color = normalizeCueColor(savedColors[name])
    if (color) cueColors[name] = color
  }
  const { minimumConfidence, vocalLoops, emergencyLoops } = knownFields(stored.analysis)
  return { cueColors, analysis: {
    minimumConfidence: minimumConfidence === .5 || minimumConfidence === .6 ? minimumConfidence : 0,
    vocalLoops: vocalLoops !== false,
    emergencyLoops: emergencyLoops === "off" || emergencyLoops === "suggest" ? emergencyLoops : "arm",
  } }
}

export function readStudioPreferences(): StudioPreferences {
  try { return parseStudioPreferences(JSON.parse(localStorage.getItem(preferencesKey) ?? "null")) }
  catch { return parseStudioPreferences(null) }
}

export function writeStudioPreferences(preferences: StudioPreferences) {
  try { localStorage.setItem(preferencesKey, JSON.stringify(preferences)) } catch { /* Preferences stay available this session. */ }
}

export function cueNameColor(label: string, colors?: CueColors): string | undefined {
  if (!colors) return undefined
  const normalized = label.trim().toLowerCase()
  const name = cueColorNames.find(item => item.toLowerCase() === normalized)
  return name ? colors[name] : undefined
}

export function displayCueColor(cue: Cue, colors?: CueColors): string | undefined {
  return cueColor(cue) ?? cueNameColor(cue.label, colors)
}
