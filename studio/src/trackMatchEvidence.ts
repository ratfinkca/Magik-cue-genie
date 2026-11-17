import type { Cue, Sidecar } from "./cues"

export type TrackEnergyEvidence = {
  rating: number
  label: "Low" | "Medium" | "High" | "Peak"
  rmsDb: number
  activity?: number
  dynamicRangeDb?: number
}
export type TrackPhraseWindow = {
  start: number
  beats: number
  source: "verified" | "measured"
  regularity: number
}
type Phrasing = { intro?: TrackPhraseWindow; outro?: TrackPhraseWindow }
export type TrackMatchEvidence = { version: 1; energy?: TrackEnergyEvidence; phrasing?: Phrasing }
type Pulse = { times: readonly number[]; period: number }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const between = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high
const unit = (value: number) => Math.max(0, Math.min(1, value))
const db = (amplitude: number) => 20 * Math.log10(Math.max(.0001, amplitude))
const round = (value: number, scale: number) => Math.round(value * scale) / scale

function energyFromSummary(value: unknown): TrackEnergyEvidence | undefined {
  if (!record(value) || !between(value.mean_rms, .0001, 1) || !between(value.max_rms, value.mean_rms, 1)) return
  const meanDb = db(value.mean_rms)
  const samples: number[] = []
  // The base analyzer stores a compact envelope of peak RMS buckets. Restore
  // their absolute level with max_rms before comparing activity across tracks.
  if (Array.isArray(value.normalized_envelope)) {
    const stride = Math.max(1, Math.ceil(value.normalized_envelope.length / 256))
    for (let index = 0; index < value.normalized_envelope.length; index += stride) {
      const normalized = value.normalized_envelope[index]
      if (between(normalized, 0, 1)) samples.push(db(normalized * value.max_rms))
    }
  }
  let score = unit((meanDb + 38) / 32)
  let activity: number | undefined
  let dynamicRangeDb: number | undefined
  if (samples.length >= 4) {
    samples.sort((a, b) => a - b)
    const quantile = (fraction: number) => samples[Math.round(fraction * (samples.length - 1))]
    activity = samples.filter(sample => sample >= -26).length / samples.length
    dynamicRangeDb = quantile(.8) - quantile(.2)
    // Absolute mean level dominates. Only sustained, active material gets a
    // smaller density contribution from the compact dynamics measurement.
    score = .78 * score + .16 * activity + .06 * activity * unit(1 - dynamicRangeDb / 24)
  }
  const rating = Math.round(1 + 9 * score)
  const label = rating <= 3 ? "Low" : rating <= 6 ? "Medium" : rating <= 8 ? "High" : "Peak"
  return { rating, label, rmsDb: round(meanDb, 10),
    ...(activity !== undefined && { activity: round(activity, 1000) }),
    ...(dynamicRangeDb !== undefined && { dynamicRangeDb: round(dynamicRangeDb, 10) }) }
}

function measuredPulse(value: unknown, duration: number): Pulse | undefined {
  if (!record(value) || value.status !== "estimated" || value.source === "generated_demo"
    || !record(value.evidence) || !between(value.evidence.period_seconds, .15, 3)
    || !Array.isArray(value.beat_times_seconds)) return
  const times = value.beat_times_seconds
  const period = value.evidence.period_seconds
  // A fitted pulse cannot contain dozens of observations inside one expected beat.
  if (times.length < 13 || times.length > 16_384
    || !times.every((time, index) => between(time, 0, duration) && (!index || time - times[index - 1] >= period * .35))) return
  return { times, period }
}

function rehearsalRegularity(pulse: Pulse, start: number, count: number): number | undefined {
  const { times, period } = pulse
  const tolerance = Math.max(.02, Math.min(.06, period * .15))
  let low = 0, high = times.length
  while (high - low > 0) {
    const middle = Math.floor((low + high) / 2)
    if (times[middle] < start - tolerance) low = middle + 1
    else high = middle
  }
  let observed = 0
  let previous = -1
  for (let index = low; index < times.length; index++) {
    const offset = (times[index] - start) / period
    const beat = Math.round(offset)
    if (beat >= count) break
    if (beat <= previous || Math.abs(offset - beat) * period > tolerance) continue
    if ((!observed && beat !== 0) || beat - previous > 3) return
    previous = beat
    observed++
  }
  if (observed >= count * .8 && previous >= count - 2) return round(observed / count, 1000)
}

function cueDirection(cue: Cue): keyof Phrasing | undefined {
  const label = cue.label.trim().toLowerCase().replace(/[ _-]+/g, " ")
  if (label === "mix in" || label === "intro") return "intro"
  if (label === "mix out" || label === "outro") return "outro"
}

function phrases(sidecar: Sidecar): Phrasing | undefined {
  const duration = sidecar.analysis.duration_seconds
  if (!between(duration, 1, Number.MAX_SAFE_INTEGER)) return
  const bpm = sidecar.analysis.estimated_bpm
  const pulse = measuredPulse(sidecar.analysis.studio_beatgrid, duration)
  const period = pulse?.period ?? (between(bpm, 20, 400) ? 60 / bpm : 0)
  if (!period) return

  const result: Phrasing = {}
  for (const cue of sidecar.cues) {
    const direction = cueDirection(cue)
    const { time_seconds: start, metadata } = cue
    const beats = metadata?.window_beats
    if (!direction || !between(beats, 4, 128) || !Number.isInteger(beats)
      || !between(start, 0, duration - beats * period)) continue
    if (metadata?.phrase_verified === true) {
      result[direction] = { start, beats, source: "verified", regularity: 1 }
    } else if (pulse && !result[direction] && metadata?.heuristic === "kick_supported_mix_window") {
      const regularity = rehearsalRegularity(pulse, start, beats)
      if (regularity !== undefined) result[direction] = { start, beats, source: "measured", regularity }
    }
  }

  if (pulse) {
    for (const direction of ["intro", "outro"] as const) {
      if (result[direction]) continue
      const intro = direction === "intro"
      for (const beats of [32, 16]) {
        const span = beats * pulse.period
        if (duration < span * 2) continue
        const { times } = pulse
        for (let step = 0; step < times.length; step++) {
          const start = times[intro ? step : times.length - 1 - step]
          if (intro ? start > duration * .30 : start < duration - Math.min(duration * .30, span * 2)) break
          if (start < .12 || start + span > duration - .12) continue
          const regularity = rehearsalRegularity(pulse, start, beats)
          if (regularity === undefined) continue
          result[direction] = { start, beats, source: "measured", regularity }
          break
        }
        if (result[direction]) break
      }
    }
  }
  return result.intro || result.outro ? result : undefined
}

/** Derive portable, track-level estimates from already-saved local preparation. */
export function readTrackMatchEvidence(sidecar: Sidecar): TrackMatchEvidence {
  const energy = energyFromSummary(sidecar.analysis.energy_summary)
  const phrasing = phrases(sidecar)
  return { version: 1, ...(energy && { energy }), ...(phrasing && { phrasing }) }
}
