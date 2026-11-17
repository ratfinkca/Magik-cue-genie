import { quantizeTime } from "./quantize"
import type { QuantizeMode } from "./quantize"
import type { DeckLoop } from "./transitionAudio"

export const LOOP_FACTORS = [.125, .25, .5, 1, 2, 4, 8] as const
export type LoopFactor = typeof LOOP_FACTORS[number]
type LoopBeats = LoopFactor | 16 | 32
export type LoopEdge = "start" | "end"
const minLoopSeconds = .05

export function normalizePerformanceLoop(start: number, end: number, duration: number): DeckLoop | null {
  if (!Number.isFinite(duration) || !Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end > duration || end < start + minLoopSeconds) return null
  return { start, end }
}

export function resizePerformanceLoop(range: DeckLoop, factor: Exclude<LoopFactor, 1>, duration: number): DeckLoop | null {
  const { start, end } = range
  if (!normalizePerformanceLoop(start, end, duration)) return null
  return normalizePerformanceLoop(start, start + (end - start) * factor, duration)
}

export function performanceLoopEdgeLimits(range: DeckLoop, edge: LoopEdge, duration: number): [number, number] {
  if (edge === "end") return [range.start + minLoopSeconds, duration]
  let upper = range.end - minLoopSeconds
  if (upper + minLoopSeconds > range.end) upper -= Number.EPSILON * Math.max(1, upper)
  return [0, Math.max(0, upper)]
}

function dragBoundary(seconds: number, minimum: number, maximum: number, beats: readonly number[], mode: QuantizeMode) {
  if (!Number.isFinite(seconds)) return null
  const bounded = Math.max(minimum, Math.min(seconds, maximum))
  const snapped = quantizeTime(bounded, beats, mode)
  return snapped >= minimum && snapped <= maximum ? snapped : null
}

export function clampPerformanceLoopEdge(range: DeckLoop, edge: LoopEdge, seconds: number, duration: number,
  beats: readonly number[] = [], mode: QuantizeMode = "off"): DeckLoop | null {
  const [minimum, maximum] = performanceLoopEdgeLimits(range, edge, duration)
  const boundary = dragBoundary(seconds, minimum, maximum, beats, mode)
  if (boundary === null) return null
  return normalizePerformanceLoop(edge === "start" ? boundary : range.start, edge === "end" ? boundary : range.end, duration)
}

export function movePerformanceLoop(range: DeckLoop, start: number, duration: number,
  beats: readonly number[] = [], mode: QuantizeMode = "off"): DeckLoop | null {
  const length = range.end - range.start
  const nextStart = dragBoundary(start, 0, duration - length, beats, mode)
  if (nextStart === null) return null
  const nextEnd = Math.min(duration, Math.max(nextStart + length, nextStart + minLoopSeconds))
  return normalizePerformanceLoop(nextStart, nextEnd, duration)
}

export function captureLoopEdge(seconds: number, beats: readonly number[], quantize: QuantizeMode, duration: number) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) return null
  const time = quantizeTime(seconds, beats, quantize)
  return Number.isFinite(time) && time >= 0 && time <= duration ? time : null
}

function periodFromBpm(bpm: number | null) {
  return bpm !== null && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400 ? 60 / bpm : null
}

function observedEnd(start: number, count: LoopBeats, beats: readonly number[], tempoPeriod: number | null) {
  if (beats.length < 2 || start < beats[0] || start >= beats[beats.length - 1]) return null
  let low = 0
  let high = beats.length
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (beats[middle] <= start) low = middle
    else high = middle
  }
  const first = low
  const interval = beats[first + 1] - beats[first]
  if (!(interval > 0)) return null
  // Start and end may land within a measured beat for fractional presets and free placement.
  const target = first + (start - beats[first]) / interval + count
  const boundary = Math.floor(target)
  const last = Math.ceil(target)
  if (last >= beats.length) return null

  const nearby = []
  for (let index = Math.max(0, first - 3); index < Math.min(beats.length - 1, last + 3); index++) {
    const interval = beats[index + 1] - beats[index]
    if (interval >= .15 && interval <= 3) nearby.push(interval)
  }
  nearby.sort((a, b) => a - b)
  const center = Math.floor(nearby.length / 2)
  const median = (nearby[center] + nearby[Math.floor((nearby.length - 1) / 2)]) / 2
  const period = nearby.length < 3 && tempoPeriod !== null ? tempoPeriod : median
  if (!(period > 0)) return null
  for (let index = first; index < last; index++) {
    const interval = beats[index + 1] - beats[index]
    if (!(interval >= period * .65 && interval <= period * 1.35)) return null
  }
  return beats[boundary] + (target - boundary) * (beats[last] - beats[boundary])
}

export function makeBeatLoop(anchor: number, count: LoopBeats, beats: readonly number[], bpm: number | null,
  quantize: QuantizeMode, duration: number): { range: DeckLoop; timing: "observed" | "tempo" } | null {
  const start = captureLoopEdge(anchor, beats, quantize, duration)
  if (start === null) return null
  const period = periodFromBpm(bpm)
  const measured = observedEnd(start, count, beats, period)
  // A tempo alone can supply duration. It has no beat-start or downbeat information.
  const end = measured ?? (period === null ? null : start + count * period)
  if (end === null) return null
  const range = normalizePerformanceLoop(start, end, duration)
  return range ? { range, timing: measured === null ? "tempo" : "observed" } : null
}
