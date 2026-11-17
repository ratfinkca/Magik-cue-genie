export type KeyNotation = 'standard' | 'camelot' | 'open'

export type TrackKey = {
  /** Twelve-tone pitch class: C = 0, C sharp / D flat = 1, …, B = 11. */
  pitchClass: number
  mode: 'major' | 'minor'
  /** Heuristic evidence score, NOT a calibrated probability of correctness. */
  confidence: number
  method: string
  analyzedWindows: number
}

// Mapping checked against the primary Mixxx control reference and Mixed In Key:
// https://manual.mixxx.org/2.5/en/chapters/appendix/mixxx_controls.html#channeln-key
// https://mixedinkey.com/camelot-wheel/0/
// Open Key starts at C major = 1d / A minor = 1m, not Camelot's 8B / 8A.
const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B']
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

export function formatKey(key: TrackKey | null | undefined, notation: KeyNotation): string {
  if (!key || !Number.isInteger(key.pitchClass) || key.pitchClass < 0 || key.pitchClass > 11
    || (key.mode !== 'major' && key.mode !== 'minor')) return 'Unclear'
  const major = key.mode === 'major'
  if (notation === 'standard') return `${(major ? MAJOR_NAMES : MINOR_NAMES)[key.pitchClass]} ${key.mode}`
  const number = (major ? MAJOR_CAMELOT : MINOR_CAMELOT)[key.pitchClass]
  return notation === 'open'
    ? `${((number + 4) % 12) + 1}${major ? 'd' : 'm'}`
    : `${number}${major ? 'B' : 'A'}`
}

// Krumhansl–Kessler empirical tonal profiles (not trained on the loaded audio).
// Profile values also documented by music21's KrumhanslSchmuckler.getWeights:
// https://music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html
const PROFILES = [
  [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
]

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Key estimation was cancelled.', 'AbortError')
}

async function yieldToUI(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  checkAbort(signal)
}

/** In-place radix-2 FFT; cooperative yields also bound individual large transforms. */
async function fft(real: Float64Array, imaginary: Float64Array, signal?: AbortSignal): Promise<void> {
  const size = real.length
  let sliceStart = performance.now()
  for (let i = 1, reversed = 0; i < size; i++) {
    let bit = size >> 1
    while (reversed & bit) { reversed ^= bit; bit >>= 1 }
    reversed ^= bit
    if (i < reversed) {
      const value = real[i]
      real[i] = real[reversed]
      real[reversed] = value
    }
  }
  for (let span = 2; span <= size; span *= 2) {
    const angle = -2 * Math.PI / span
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < size; start += span) {
      let phaseReal = 1
      let phaseImaginary = 0
      for (let offset = 0; offset < span / 2; offset++) {
        const left = start + offset
        const right = left + span / 2
        const productReal = phaseReal * real[right] - phaseImaginary * imaginary[right]
        const productImaginary = phaseReal * imaginary[right] + phaseImaginary * real[right]
        real[right] = real[left] - productReal
        imaginary[right] = imaginary[left] - productImaginary
        real[left] += productReal
        imaginary[left] += productImaginary
        const nextReal = phaseReal * stepReal - phaseImaginary * stepImaginary
        phaseImaginary = phaseReal * stepImaginary + phaseImaginary * stepReal
        phaseReal = nextReal
      }
    }
    if (performance.now() - sliceStart >= 8) {
      await yieldToUI(signal)
      sliceStart = performance.now()
    }
  }
}

type Candidate = { pitchClass: number; mode: 'major' | 'minor'; score: number }

function rankKeys(chroma: Float64Array): Candidate[] {
  const mean = chroma.reduce((sum, value) => sum + value, 0) / 12
  const variance = chroma.reduce((sum, value) => sum + (value - mean) ** 2, 0)
  const candidates: Candidate[] = []
  for (let mode = 0; mode < 2; mode++) {
    const profile = PROFILES[mode]
    const profileMean = profile.reduce((sum, value) => sum + value, 0) / 12
    const profileVariance = profile.reduce((sum, value) => sum + (value - profileMean) ** 2, 0)
    for (let root = 0; root < 12; root++) {
      let covariance = 0
      for (let pitch = 0; pitch < 12; pitch++) {
        covariance += (chroma[pitch] - mean) * (profile[(pitch - root + 12) % 12] - profileMean)
      }
      candidates.push({ pitchClass: root, mode: mode === 0 ? 'major' : 'minor',
        score: variance > 0 ? covariance / Math.sqrt(variance * profileVariance) : 0 })
    }
  }
  return candidates.sort((a, b) => b.score - a.score)
}

/**
 * Browser-local tonal estimate, not an authoritative musical-key detector.
 * Reads at most 32 short windows, at the ORIGINAL sample rate (no aliasing from
 * naive decimation). Uses the louder of the first two channels per window so
 * opposite-polarity stereo does not cancel. No AudioContext, uploads or mutation.
 * Assumes approximately A440 twelve-tone major/minor music; relative keys,
 * modal music, tuning drift, dense harmonics and modulation may be ambiguous.
 * Returns null for inadequate/ambiguous evidence; cancellation rejects AbortError.
 */
export async function estimateKey(buffer: AudioBuffer, signal?: AbortSignal): Promise<TrackKey | null> {
  checkAbort(signal)
  const rate = buffer.sampleRate
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000 || buffer.duration < 1.5
    || buffer.numberOfChannels < 1 || buffer.length < 4096) return null
  const size = Math.min(65536, Math.max(4096, 2 ** Math.round(Math.log2(rate * 0.68))))
  if (buffer.length < size) return null
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, i) => buffer.getChannelData(i))
  const count = Math.min(32, Math.max(2, Math.floor(buffer.duration / 0.6)))
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  const power = new Float64Array(size / 2)
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)))
  const aggregate = new Float64Array(12)
  const windowChromas: Float64Array[] = []
  const low = Math.max(4, Math.ceil(65 * size / rate))
  const high = Math.min(size / 2 - 4, Math.floor(2200 * size / rate))

  for (let frame = 0; frame < count; frame++) {
    await yieldToUI(signal)
    const start = Math.floor((buffer.length - size) * frame / (count - 1))
    let selected = channels[0]
    let largestEnergy = -1
    for (const channel of channels) {
      let energy = 0
      for (let i = 0; i < size; i += 16) energy += channel[start + i] ** 2
      if (energy > largestEnergy) { largestEnergy = energy; selected = channel }
    }
    let mean = 0
    for (let i = 0; i < size; i++) mean += selected[start + i]
    mean /= size
    let energy = 0
    for (let i = 0; i < size; i++) {
      const value = selected[start + i] - mean
      energy += value * value
      real[i] = value * window[i]
    }
    if (!Number.isFinite(energy) || energy / size < 1e-8) continue
    imaginary.fill(0)
    await fft(real, imaginary, signal)
    let sumPower = 0
    let logPower = 0
    let peakPower = 0
    for (let bin = low - 3; bin <= high + 3; bin++) {
      power[bin] = real[bin] ** 2 + imaginary[bin] ** 2
      if (bin >= low && bin <= high) {
        sumPower += power[bin]
        logPower += Math.log(power[bin] + 1e-20)
        peakPower = Math.max(peakPower, power[bin])
      }
    }
    const bandSize = high - low + 1
    const flatness = Math.exp(logPower / bandSize) / (sumPower / bandSize + 1e-20)
    if (flatness > 0.3 || peakPower <= 0) continue
    const chroma = new Float64Array(12)
    for (let bin = low; bin <= high; bin++) {
      const value = power[bin]
      if (value < peakPower * 0.0025 || value <= power[bin - 1] || value < power[bin + 1]) continue
      // Short pitched kicks produce broad peaks that can outweigh quiet chords.
      // Require a resolved tonal peak (6 dB over its nearby sidebands), rather
      // than interpreting every local maximum as a sustained musical pitch.
      // This deliberately sacrifices uncertain/varying tones instead of letting
      // percussion confidently determine the key; it is not stem separation.
      if (value < 4 * (power[bin - 3] + power[bin + 3]) / 2) continue
      // Parabolic interpolation of a Hann-windowed log spectrum reduces bin bias.
      const before = Math.log(power[bin - 1] + 1e-20)
      const at = Math.log(value + 1e-20)
      const after = Math.log(power[bin + 1] + 1e-20)
      const denominator = before - 2 * at + after
      const shift = denominator ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator)) : 0
      const frequency = (bin + shift) * rate / size
      const midi = 69 + 12 * Math.log2(frequency / 440)
      const note = Math.round(midi)
      const distance = Math.abs(midi - note)
      if (distance > 0.45) continue
      chroma[((note % 12) + 12) % 12] += Math.sqrt(value) * (1 - distance) * (440 / frequency) ** 0.3
    }
    const total = chroma.reduce((sum, value) => sum + value, 0)
    if (total <= 0) continue
    for (let pitch = 0; pitch < 12; pitch++) {
      chroma[pitch] /= total
      aggregate[pitch] += chroma[pitch]
    }
    windowChromas.push(chroma)
  }
  checkAbort(signal)
  if (windowChromas.length < Math.max(2, Math.ceil(count * 0.15))) return null
  const largestPitch = Math.max(...aggregate)
  if (aggregate.filter((value) => value > largestPitch * 0.12).length < 3) return null
  const [best, second] = rankKeys(aggregate)
  const margin = best.score - second.score
  const support = windowChromas.filter((chroma) => {
    const candidates = rankKeys(chroma)
    return candidates.slice(0, 3).some((candidate) => candidate.pitchClass === best.pitchClass && candidate.mode === best.mode)
  }).length / windowChromas.length
  if (best.score < 0.62 || margin < 0.045 || support < 0.55) return null
  const confidence = Math.min(0.95, Math.max(0, (best.score - 0.4) * 0.8 + Math.min(0.3, margin * 2) + support * 0.15))
  return { pitchClass: best.pitchClass, mode: best.mode, confidence,
    method: 'sampled-chroma-v1', analyzedWindows: windowChromas.length }
}
