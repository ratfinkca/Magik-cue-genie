import type { DeckId } from "./transitionAudio"

export const PITCH_MIN_PERCENT = 50
export const PITCH_MAX_PERCENT = 200
export const GAIN_MIN_DB = -60
export const GAIN_MAX_DB = 18

const sharpEdgePercent = 15
export const CROSSFADER_CURVES = {
  "equal-power": { label: "Equal power", marks: [0, 50, 100] },
  linear: { label: "Linear", marks: [0, 50, 100] },
  sharp: { label: "Sharp", marks: [0, sharpEdgePercent, 50, 100 - sharpEdgePercent, 100] },
  custom: { label: "Custom", marks: [0, 50, 100] },
} as const

export type CrossfaderCurve = keyof typeof CROSSFADER_CURVES
export const DEFAULT_CROSSFADER_CURVE: CrossfaderCurve = "equal-power"
export type CrossfaderCustom = { cut: number; softness: number }
export const DEFAULT_CROSSFADER_CUSTOM: CrossfaderCustom = { cut: 50, softness: 50 }

export function normalizeCrossfaderCustom(value: unknown): CrossfaderCustom {
  function setting(number: unknown, fallback: number) {
    return typeof number === "number" && Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback
  }
  const settings = value && typeof value === "object" ? value as Partial<CrossfaderCustom> : {}
  return {
    cut: setting(settings.cut, DEFAULT_CROSSFADER_CUSTOM.cut),
    softness: setting(settings.softness, DEFAULT_CROSSFADER_CUSTOM.softness),
  }
}

export function isCrossfaderCurve(value: unknown): value is CrossfaderCurve {
  return typeof value === "string" && Object.hasOwn(CROSSFADER_CURVES, value)
}

export function normalizeGainDb(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, value))
    : 0
}

export function normalizeChannelVolume(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value)) : 100
}

export function normalizeFaderPosition(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
}

/** A channel is fully open this far in from its muted end of the fader. */
export function customCrossfaderWidth(custom: CrossfaderCustom) {
  return Math.round(100 - .97 * custom.cut)
}

export function getCrossfaderMarks(curve: CrossfaderCurve, custom = DEFAULT_CROSSFADER_CUSTOM): readonly number[] {
  if (curve !== "custom") return CROSSFADER_CURVES[curve].marks
  const width = customCrossfaderWidth(custom)
  return Array.from(new Set([0, width, 50, 100 - width, 100])).sort((a, b) => a - b)
}

export function getCrossfaderGain(id: DeckId, value: number, curve: CrossfaderCurve, custom = DEFAULT_CROSSFADER_CUSTOM) {
  const position = normalizeFaderPosition(value)
  const opening = id === "A" ? 100 - position : position
  if (curve === "sharp") return Math.min(1, opening / sharpEdgePercent)
  if (curve === "linear") return opening / 100
  if (curve === "custom") {
    const linear = Math.min(1, opening / customCrossfaderWidth(custom))
    if (linear === 0 || linear === 1) return linear
    return linear + (Math.sin(linear * Math.PI / 2) - linear) * custom.softness / 100
  }
  if (opening === 0 || opening === 100) return opening / 100
  return Math.sin(opening * Math.PI / 200)
}

export function getDeckOutputGain(id: DeckId, position: number, curve: CrossfaderCurve, gainDb: number,
  custom = DEFAULT_CROSSFADER_CUSTOM) {
  return getCrossfaderGain(id, position, curve, custom) * 10 ** (normalizeGainDb(gainDb) / 20)
}
