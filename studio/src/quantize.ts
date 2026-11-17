export type QuantizeMode = "off" | "beat" | "half" | "quarter" | "eighth"

const divisions: Record<Exclude<QuantizeMode, "off">, number> = {
  beat: 1, half: 2, quarter: 4, eighth: 8,
}

function isSupportedInterval(seconds: number) {
  // Adjacent generated beats can differ from their exact period by floating-point roundoff.
  return seconds >= 0.15 - 1e-9 && seconds <= 1.5 + 1e-9
}

/** Snap only where surrounding observations support the selected subdivision. */
export function quantizeTime(seconds: number, beats: readonly number[], mode: QuantizeMode): number {
  if (mode === "off" || beats.length < 2 || !Number.isFinite(seconds)
    || seconds < beats[0] || seconds > beats[beats.length - 1]) return seconds

  let lo = 0
  let hi = beats.length - 1
  while (hi - lo > 1) {
    const middle = Math.floor((lo + hi) / 2)
    if (beats[middle] <= seconds) lo = middle
    else hi = middle
  }
  const left = beats[lo]
  const right = beats[hi]
  const span = right - left
  const nearest = seconds - left <= right - seconds ? left : right
  if (!(span > 0)) return seconds
  if (seconds === left || seconds === right) return seconds

  const neighbors: number[] = []
  for (let index = Math.max(0, lo - 3); index < Math.min(beats.length - 1, hi + 3); index++) {
    if (index === lo) continue
    const interval = beats[index + 1] - beats[index]
    if (isSupportedInterval(interval)) neighbors.push(interval)
  }
  neighbors.sort((a, b) => a - b)
  const middle = Math.floor(neighbors.length / 2)
  const period = neighbors.length ? (neighbors[middle] + neighbors[Math.floor((neighbors.length - 1) / 2)]) / 2 : NaN

  if (!isSupportedInterval(span) || !Number.isFinite(period) || Math.abs(span - period) > 0.22 * period) {
    // An observed beat can still be selected nearby, even at the edge of a gap.
    const radius = Number.isFinite(period) ? Math.min(0.08, period / 8) : 0.04
    return Math.abs(nearest - seconds) <= radius ? nearest : seconds
  }

  const count = divisions[mode]
  if (count === 1) return nearest
  const step = span / count
  const stepIndex = Math.round((seconds - left) / step)
  return stepIndex === count ? right : left + stepIndex * step
}
