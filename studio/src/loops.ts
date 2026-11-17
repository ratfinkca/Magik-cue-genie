import type { Cue } from './cues'
import type { WaveformData } from './waveform'

export type CueLoop = { end_seconds: number; active: boolean; kind: 'emergency' | 'vocal' | 'manual' }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Invalid imported metadata never becomes an active playback loop. */
export function getLoop(cue: Cue, duration = Infinity): CueLoop | null {
  const value = cue.metadata?.loop
  if (!record(value) || typeof value.end_seconds !== 'number' || !Number.isFinite(value.end_seconds)
    || typeof value.active !== 'boolean' || typeof value.kind !== 'string'
    || !['emergency', 'vocal', 'manual'].includes(value.kind)
    || !Number.isFinite(cue.time_seconds) || cue.time_seconds < 0 || value.end_seconds <= cue.time_seconds
    || !(duration > 0) || value.end_seconds > duration) return null
  return { end_seconds: value.end_seconds, active: value.active, kind: value.kind as CueLoop['kind'] }
}

function barLength(bpm: number | null, beatsPerBar: number): number | null {
  return bpm !== null && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400
    && Number.isInteger(beatsPerBar) && beatsPerBar >= 1 && beatsPerBar <= 16
    ? 60 / bpm * beatsPerBar : null
}

function makeLoop(start: number, length: number, kind: 'emergency' | 'vocal', reason: string,
  confidence: number, bpm: number, beatsPerBar: number, method: string): Cue {
  return {
    label: kind === 'emergency' ? 'Emergency loop' : 'Vocal loop',
    time_seconds: start, confidence, reason,
    metadata: { loop: { end_seconds: start + length, active: kind === 'emergency', kind },
      loop_method: method, approximate: true, bpm, beats_per_bar: beatsPerBar },
  }
}

const MAX_BEAT_ERROR = 0.02

function earliestEmergencyStart(duration: number): number {
  return duration - Math.min(30, duration * 0.25)
}

function isLateEmergency(start: number, end: number, duration: number): boolean {
  return Number.isFinite(duration) && start >= earliestEmergencyStart(duration)
    && end >= duration - Math.min(15, duration * 0.15) && end <= duration
}

function validBeatTimes(beatTimes: readonly number[], duration: number): boolean {
  return beatTimes.length >= 3 && beatTimes.length <= 16_384
    && beatTimes.every((time, index) => Number.isFinite(time) && time >= 0 && time <= duration
      && (index === 0 || time > beatTimes[index - 1]))
}

function firstAtOrAfter(times: readonly number[], target: number): number {
  let left = 0
  let right = times.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (times[middle] < target) left = middle + 1
    else right = middle
  }
  return left
}

function nearestBeatIndex(times: readonly number[], target: number): number {
  const next = firstAtOrAfter(times, target)
  if (next === times.length) return next - 1
  if (next > 0 && target - times[next - 1] < times[next] - target) return next - 1
  return next
}

/** Interval and phase both need support so a missing interior beat is rejected. */
function steadyBeatPeriod(beatTimes: readonly number[], first: number, last: number): number | null {
  const count = last - first
  const length = beatTimes[last] - beatTimes[first]
  if (count < 2 || length < 0.75) return null
  const period = length / count
  if (period < 0.15 || period > 3) return null
  const tolerance = Math.min(0.04, period * 0.10)
  for (let index = first + 1; index <= last; index++) {
    if (Math.abs(beatTimes[index] - beatTimes[index - 1] - period) > tolerance
      || Math.abs(beatTimes[index] - beatTimes[first] - (index - first) * period) > tolerance) return null
  }
  return period
}

/** Recheck imported or moved emergency loops against this track's actual grid. */
export function canArmEmergencyLoop(cue: Cue, duration: number, beatTimes: readonly number[]): boolean {
  const loop = getLoop(cue, duration)
  if (loop?.kind !== 'emergency' || !isLateEmergency(cue.time_seconds, loop.end_seconds, duration)
    || !validBeatTimes(beatTimes, duration)) return false
  const first = nearestBeatIndex(beatTimes, cue.time_seconds)
  const last = nearestBeatIndex(beatTimes, loop.end_seconds)
  const startError = cue.time_seconds - beatTimes[first]
  const endError = loop.end_seconds - beatTimes[last]
  return Math.abs(startError) <= MAX_BEAT_ERROR && Math.abs(endError) <= MAX_BEAT_ERROR
    && Math.abs(endError - startError) <= MAX_BEAT_ERROR
    && steadyBeatPeriod(beatTimes, first, last) !== null
}

/**
 * Use consecutive observed beats at the end and retain the low-band check
 * for stable audio. A reasonable tempo alone does not justify an armed loop.
 */
export function suggestEmergencyLoop(cues: Cue[], bpm: number | null, waveform: WaveformData | null,
  duration: number, beatsPerBar = 4, beatTimes: readonly number[] = []): Cue | null {
  const bar = barLength(bpm, beatsPerBar)
  if (bar === null || !Number.isFinite(duration) || duration <= 0 || !waveform
    || !Number.isFinite(waveform.duration) || Math.abs(waveform.duration - duration) > 0.05
    || !Number.isInteger(waveform.binCount) || waveform.binCount < 16
    || waveform.low.length !== waveform.binCount
    || !validBeatTimes(beatTimes, duration)
    || cues.some((cue) => getLoop(cue, duration)?.kind === 'emergency')) return null
  const { low, binCount } = waveform
  const binsPerSecond = binCount / duration
  const nominalBeat = bar / beatsPerBar
  let maximum = 0
  for (const value of low) {
    if (!Number.isFinite(value) || value < 0) return null
    maximum = Math.max(maximum, value)
  }
  if (maximum < 0.001) return null
  // At most 30 seconds of candidate starts are considered, regardless of track length.
  const firstLate = firstAtOrAfter(beatTimes, earliestEmergencyStart(duration))
  let best: { start: number; end: number; beat: number; count: number; score: number; correlation: number } | null = null
  for (const bars of [2, 1]) {
    const beats = bars * beatsPerBar
    for (let first = firstLate; first + beats < beatTimes.length; first++) {
      const last = first + beats
      const start = beatTimes[first], end = beatTimes[last]
      if (end > duration - 0.1) break
      if (!isLateEmergency(start, end, duration)) continue
      const beat = steadyBeatPeriod(beatTimes, first, last)
      if (beat === null || Math.abs(beat - nominalBeat) > nominalBeat * 0.08) continue
      const lag = Math.round(beat * binsPerSecond)
      if (lag < 4) continue
      const from = Math.floor(start * binsPerSecond)
      const to = Math.min(binCount, Math.floor(end * binsPerSecond))
      if (to - from <= lag + 1) continue
      let sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0
      const count = to - from - lag
      for (let i = from; i < to - lag; i++) {
        const a = low[i], b = low[i + lag]
        sumA += a; sumB += b; squareA += a * a; squareB += b * b; product += a * b
      }
      const varianceA = squareA - sumA * sumA / count
      const varianceB = squareB - sumB * sumB / count
      if (varianceA <= 1e-12 || varianceB <= 1e-12) continue
      const correlation = (product - sumA * sumB / count) / Math.sqrt(varianceA * varianceB)
      if (correlation < 0.35) continue
      const energies: number[] = []
      for (let step = first; step < last; step++) {
        const begin = Math.floor(beatTimes[step] * binsPerSecond)
        const limit = Math.min(to, Math.floor(beatTimes[step + 1] * binsPerSecond))
        let energy = 0
        for (let i = begin; i < limit; i++) energy += low[i] ** 2
        energies.push(Math.sqrt(energy / Math.max(1, limit - begin)))
      }
      const mean = energies.reduce((sum, value) => sum + value, 0) / energies.length
      const variation = Math.sqrt(energies.reduce((sum, value) => sum + (value - mean) ** 2, 0) / energies.length) / (mean + 1e-12)
      if (mean < maximum * 0.06 || variation > 0.4
        || Math.min(...energies) < mean * 0.5 || energies.at(-1)! < energies[0] * 0.65) continue
      const nearCue = cues.some((cue) => Number.isFinite(cue.time_seconds)
        && /^(outro|mix out)$/i.test(cue.label.trim()) && Math.abs(cue.time_seconds - start) < bar * 2)
      const score = correlation * 0.55 + (1 - variation) * 0.25
        + (1 - (duration - end) / 15) * 0.1 + (nearCue ? 0.05 : 0) + (bars === 2 ? 0.05 : 0)
      if (!best || score > best.score) best = { start, end, beat, count: beats, score, correlation }
    }
  }
  if (!best) return null
  const cue = makeLoop(best.start, best.end - best.start, 'emergency',
    `Emergency loop over ${best.count} consecutive observed beats near the end. Low-band energy stays steady. Audition the loop seam.`,
    Math.min(0.80, 0.55 + best.correlation * 0.2), 60 / best.beat, beatsPerBar, 'observed-beats-and-low-band-v2')
  cue.metadata = { ...cue.metadata, beat_aligned: true, observed_beats: best.count, requires_review: true }
  return cue
}

const vocalStartLabels = new Set(['vocal', 'vocals', 'vocal in', 'vocals in', 'vocal start', 'vocals start'])
const vocalEndLabels = new Set(['vocal out', 'vocals out', 'vocal end', 'vocals end'])
function vocalEvent(cue: Cue, event: 'start' | 'end'): boolean {
  const label = cue.label.trim().toLowerCase().replace(/\s+/g, ' ')
  return (event === 'start' ? vocalStartLabels : vocalEndLabels).has(label)
    || (cue.metadata?.vocals_verified === true && cue.metadata.vocal_event === event)
}

/** Only explicit positive entry labels or verified event metadata establish vocals. */
export function suggestVocalLoop(cues: Cue[], bpm: number | null, duration: number, beatsPerBar = 4): Cue | null {
  const bar = barLength(bpm, beatsPerBar)
  if (bar === null || !Number.isFinite(duration) || duration <= 0
    || cues.some((cue) => getLoop(cue, duration)?.kind === 'vocal')) return null
  const entries = cues.filter((cue) => vocalEvent(cue, 'start') && Number.isFinite(cue.time_seconds)
    && cue.time_seconds >= 0).sort((a, b) => a.time_seconds - b.time_seconds)
  for (const entry of entries) {
    const nextEnd = cues.filter((cue) => vocalEvent(cue, 'end') && Number.isFinite(cue.time_seconds)
      && cue.time_seconds > entry.time_seconds).reduce((end, cue) => Math.min(end, cue.time_seconds), duration)
    const bars = [2, 1].find((count) => entry.time_seconds + count * bar <= Math.min(duration, nextEnd))
    if (!bars) continue
    return makeLoop(entry.time_seconds, bars * bar, 'vocal',
      `Approximate ${bars}-bar loop from an explicitly marked vocal entry. Length uses ${bpm} BPM; audition the phrase and loop boundary before enabling.`,
      Math.min(0.65, Number.isFinite(entry.confidence) ? Math.max(0, entry.confidence) : 0.5),
      bpm!, beatsPerBar, 'explicit-vocal-entry-v1')
  }
  return null
}

/**
 * The CALLER must supply an isolated vocal stem aligned to the loaded track.
 * RMS detects activity in that stem, not vocal identity in an ordinary full mix.
 * Leakage/breath/noise can still trigger it; output stays inactive until reviewed.
 */
export async function suggestVocalLoopFromStem(buffer: AudioBuffer, duration: number,
  bpm: number | null, beatsPerBar = 4, signal?: AbortSignal): Promise<Cue | null> {
  const abort = () => { if (signal?.aborted) throw new DOMException('Stem analysis cancelled.', 'AbortError') }
  abort()
  const bar = barLength(bpm, beatsPerBar)
  if (bar === null || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(buffer.duration)
    || Math.abs(buffer.duration - duration) > 0.05 || buffer.length < 1 || buffer.numberOfChannels < 1) return null
  const count = Math.min(30000, Math.ceil(duration / 0.02))
  const rms = new Float64Array(count)
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, i) => buffer.getChannelData(i))
  let deadline = performance.now() + 8
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (let bin = 0; bin < count; bin++) {
    abort()
    const first = Math.floor(bin * buffer.length / count)
    const last = Math.floor((bin + 1) * buffer.length / count)
    const stride = Math.max(1, Math.floor((last - first) / 32))
    let energy = 0, samples = 0
    for (const channel of channels) for (let i = first; i < last; i += stride) {
      const sample = channel[i]
      if (Number.isFinite(sample)) { energy += sample * sample; samples++ }
    }
    rms[bin] = Math.sqrt(energy / Math.max(1, samples))
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      deadline = performance.now() + 8
    }
  }
  abort()
  const sorted = Array.from(rms).sort((a, b) => a - b)
  const peak = sorted.at(-1) ?? 0
  const threshold = Math.max(0.002, peak * 0.12, sorted[Math.floor(count * 0.2)] * 3)
  if (peak < threshold) return null
  const binSeconds = duration / count
  const gapLimit = Math.max(1, Math.floor(0.16 / binSeconds))
  for (let first = 0; first < count; first++) {
    if (rms[first] < threshold) continue
    let lastActive = first, gap = 0, active = 0, end = first
    for (; end < count; end++) {
      if (rms[end] >= threshold) { lastActive = end; gap = 0; active++ }
      else if (++gap > gapLimit) break
    }
    const start = first * binSeconds
    const activeLength = (lastActive - first + 1) * binSeconds
    const bars = [1, 2].find((value) => activeLength <= value * bar && start + value * bar <= duration)
    if (bars && activeLength >= 0.5 && active / (lastActive - first + 1) >= 0.65) {
      return makeLoop(start, bars * bar, 'vocal',
        `Approximate ${bars}-bar loop around activity in the supplied isolated vocal stem. This is an energy-based activity estimate, not vocal recognition; audition for leakage and phrase boundaries.`,
        0.5, bpm!, beatsPerBar, 'supplied-vocal-stem-activity-v1')
    }
    first = end
  }
  return null
}
