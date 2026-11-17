export type TimelineGrid = "seconds" | "beats" | "bars"
export type TimelineBeat = { time: number; index: number; estimated: boolean }

function supportedPeriod(seconds: number) {
  return seconds >= .15 && seconds <= 1.5
}

function localPeriod(beats: readonly number[], gap: number, tempoPeriod: number | null) {
  const periods: number[] = []
  for (let index = Math.max(1, gap - 4); index <= Math.min(beats.length - 1, gap + 4); index++) {
    if (index === gap) continue
    const period = beats[index] - beats[index - 1]
    if (supportedPeriod(period)) periods.push(period)
  }
  periods.sort((a, b) => a - b)
  let best: number[] = []
  for (const candidate of periods) {
    const cluster = periods.filter(period => Math.abs(period / candidate - 1) <= .16)
    if (cluster.length > best.length) best = cluster
  }
  if (best.length < 2) return tempoPeriod
  return (best[Math.floor((best.length - 1) / 2)] + best[Math.floor(best.length / 2)]) / 2
}

function matchingIntervals(gap: number, period: number, tempoPeriod: number | null) {
  let intervalCount = gap / period
  if (tempoPeriod !== null && Math.abs(tempoPeriod / period - 1) <= .08) {
    const fromTempo = gap / tempoPeriod
    if (Math.abs(fromTempo - Math.round(fromTempo)) < Math.abs(intervalCount - Math.round(intervalCount))) intervalCount = fromTempo
  }
  const count = Math.round(intervalCount)
  // A bounded estimate can connect several bars across an unobserved break.
  return count >= 2 && count <= 128 && Math.abs(intervalCount - count) <= .35 ? count : 1
}

/** Keep the analyzer's observations intact. Fill rhythmically supported gaps for the display only. */
export function estimateBeatGrid(beats: readonly number[], bpm: number | null | undefined,
  minimum: number): TimelineBeat[] {
  const bpmPeriod = typeof bpm === "number" ? 60 / bpm : NaN
  const tempoPeriod = supportedPeriod(bpmPeriod) ? bpmPeriod : null
  const openingPeriod = localPeriod(beats, 0, tempoPeriod)
  const anchor = beats[0] ?? 0
  const result: TimelineBeat[] = []
  if (openingPeriod !== null && minimum < 0) {
    const first = Math.ceil((minimum - anchor) / openingPeriod)
    const zero = Math.ceil((-anchor - 1e-7) / openingPeriod)
    for (let index = first; index < zero; index++) {
      const time = anchor + index * openingPeriod
      result.push({ time, index, estimated: true })
    }
  }
  let ordinal = 0
  for (let index = 0; index < beats.length; index++) {
    if (index > 0) {
      const gap = beats[index] - beats[index - 1]
      const expected = localPeriod(beats, index, tempoPeriod)
      const count = expected === null ? 1 : matchingIntervals(gap, expected, tempoPeriod)
      for (let step = 1; step < count; step++) {
        result.push({ time: beats[index - 1] + step * gap / count, index: ordinal++, estimated: true })
      }
    }
    result.push({ time: beats[index], index: ordinal++, estimated: false })
  }
  return result
}

function gridIndex(beats: readonly TimelineBeat[], time: number) {
  let left = 0
  let right = beats.length
  while (left < right) {
    const middle = Math.floor((left + right) / 2)
    if (beats[middle].time < time) left = middle + 1
    else right = middle
  }
  return left
}

/** Preserve grid ordinals so counted bars stay put while scrubbing. */
export function timelineGridTicks(beats: readonly TimelineBeat[], start: number, end: number, width: number,
  meter: number | null, showBeats = true) {
  const first = gridIndex(beats, start)
  const last = gridIndex(beats, end)
  const includeBeats = showBeats && last - first <= Math.max(1, width / 6)
  const ticks: { time: number; number: number; bar: number | null; estimated: boolean }[] = []
  for (let i = first; i < last; i++) {
    const { time, index, estimated } = beats[i]
    const before = index < 0
    const bar = meter !== null && index % meter === 0 ? index / meter + (before ? 0 : 1) : null
    if (includeBeats || bar !== null) ticks.push({ time, number: index + (before ? 0 : 1), bar, estimated })
  }
  return ticks
}
