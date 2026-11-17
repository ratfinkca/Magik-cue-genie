export type WaveformMode = 'rgb' | 'bands' | 'split'

export interface WaveformData {
  duration: number
  binCount: number
  /** RMS band amplitudes, normalized together against the track's largest peak. */
  low: Float32Array
  mid: Float32Array
  high: Float32Array
  peak: Float32Array
}

const MAX_BINS = 32_768
const BINS_PER_SECOND = 256
const LOW_CROSSOVER_HZ = 250
const HIGH_CROSSOVER_HZ = 2_500

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Approximate frequency bands with complementary first-order filters. Analyze
 * channels separately and average their energy, never their samples: antiphase
 * stereo must remain visible. The AudioBuffer is only read, never modified.
 */
export async function buildWaveform(buffer: AudioBuffer, signal?: AbortSignal): Promise<WaveformData> {
  const { length, sampleRate, numberOfChannels } = buffer
  if (length < 1 || sampleRate <= 0 || numberOfChannels < 1) {
    throw new Error('The decoded track contains no audio samples.')
  }
  const duration = length / sampleRate
  const binCount = Math.min(MAX_BINS, length, Math.max(1, Math.ceil(duration * BINS_PER_SECOND)))
  const data: WaveformData = {
    duration,
    binCount,
    low: new Float32Array(binCount),
    mid: new Float32Array(binCount),
    high: new Float32Array(binCount),
    peak: new Float32Array(binCount),
  }
  const channels = Array.from({ length: numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  const lowerState = new Float64Array(numberOfChannels)
  const upperState = new Float64Array(numberOfChannels)
  const upperCutoff = Math.min(HIGH_CROSSOVER_HZ, sampleRate * 0.45)
  const lowerCutoff = Math.min(LOW_CROSSOVER_HZ, upperCutoff / 2)
  const lowerAlpha = 1 - Math.exp(-2 * Math.PI * lowerCutoff / sampleRate)
  const upperAlpha = 1 - Math.exp(-2 * Math.PI * upperCutoff / sampleRate)
  let maximumPeak = 0
  let deadline = performance.now() + 8

  // Yield once before work, then at most every ~8 ms of analysis, so transport
  // controls and loading feedback can paint even for a long decoded track.
  await yieldToBrowser()
  signal?.throwIfAborted()
  for (let bin = 0; bin < binCount; bin += 1) {
    const first = Math.floor(bin * length / binCount)
    const last = Math.floor((bin + 1) * length / binCount)
    let lowEnergy = 0
    let midEnergy = 0
    let highEnergy = 0
    let peak = 0

    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const samples = channels[channel]
      let lower = lowerState[channel]
      let upper = upperState[channel]
      for (let frame = first; frame < last; frame += 1) {
        const sample = Number.isFinite(samples[frame]) ? samples[frame] : 0
        lower += lowerAlpha * (sample - lower)
        upper += upperAlpha * (sample - upper)
        const middle = upper - lower
        const high = sample - upper
        lowEnergy += lower * lower
        midEnergy += middle * middle
        highEnergy += high * high
        peak = Math.max(peak, Math.abs(sample))

        if ((frame & 4095) === 0 && performance.now() >= deadline) {
          await yieldToBrowser()
          signal?.throwIfAborted()
          deadline = performance.now() + 8
        }
      }
      lowerState[channel] = lower
      upperState[channel] = upper
    }

    const count = (last - first) * numberOfChannels
    data.low[bin] = Math.sqrt(lowEnergy / count)
    data.mid[bin] = Math.sqrt(midEnergy / count)
    data.high[bin] = Math.sqrt(highEnergy / count)
    data.peak[bin] = peak
    maximumPeak = Math.max(maximumPeak, peak)
  }

  // One shared scale preserves the frequency balance; silent tracks stay zero.
  if (maximumPeak > 0) {
    for (const band of [data.low, data.mid, data.high, data.peak]) {
      for (let bin = 0; bin < binCount; bin += 1) {
        band[bin] = Math.min(1, band[bin] / maximumPeak)
      }
    }
  }
  return data
}

export function centeredTimeRange(duration: number, position: number, zoom: number) {
  const span = Math.max(0, duration) / Math.max(1, zoom)
  const center = Math.max(0, Math.min(duration, position))
  return { start: center - span / 2, end: center + span / 2, span }
}

export function timelineStep(span: number, width: number): number {
  const desired = span / Math.max(2, Math.floor(width / 90))
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(0.001, desired))))
  return [1, 2, 5, 10].map((step) => step * magnitude).find((step) => step >= desired) ?? magnitude * 10
}

type WaveformLevel = Omit<WaveformData, 'duration'> & { stride: number }
const summaries = new WeakMap<WaveformData, WaveformLevel[]>()

/** Cache a peak/RMS pyramid once. Each screen column then reads only a few bins. */
function waveformLevels(data: WaveformData): WaveformLevel[] {
  const cached = summaries.get(data)
  if (cached) return cached
  const levels: WaveformLevel[] = [{ ...data, stride: 1 }]
  let previous = levels[0]
  while (previous.binCount > 1) {
    const binCount = Math.ceil(previous.binCount / 2)
    const next: WaveformLevel = {
      binCount, stride: previous.stride * 2,
      low: new Float32Array(binCount), mid: new Float32Array(binCount),
      high: new Float32Array(binCount), peak: new Float32Array(binCount),
    }
    for (let bin = 0; bin < binCount; bin += 1) {
      const left = bin * 2
      const right = Math.min(left + 1, previous.binCount - 1)
      const leftCount = Math.min(previous.stride, data.binCount - left * previous.stride)
      const rightCount = left === right ? 0 : Math.min(previous.stride, data.binCount - right * previous.stride)
      for (const band of ['low', 'mid', 'high'] as const) {
        next[band][bin] = Math.sqrt((previous[band][left] ** 2 * leftCount
          + previous[band][right] ** 2 * rightCount) / (leftCount + rightCount))
      }
      next.peak[bin] = Math.max(previous.peak[left], previous.peak[right])
    }
    levels.push(next)
    previous = next
  }
  summaries.set(data, levels)
  return levels
}

/**
 * Draw the requested timeline without clamping its edges to the track. Empty
 * space before/after the audio keeps the transport line centered at all times.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  data: WaveformData,
  startSec: number,
  endSec: number,
  mode: WaveformMode,
  timeGrid = true,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const bounds = canvas.getBoundingClientRect()
  const width = Math.round(bounds.width)
  const height = Math.round(bounds.height)
  if (width < 1 || height < 1) return
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1)
  const pixelWidth = Math.round(width * pixelRatio)
  const pixelHeight = Math.round(height * pixelRatio)
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  const start = Number.isFinite(startSec) ? startSec : 0
  const end = Number.isFinite(endSec) ? endSec : data.duration
  const span = end - start
  if (span <= 0 || data.binCount < 1 || data.duration <= 0) return

  const compact = height < 90
  const top = compact ? 3 : 29
  const plotHeight = Math.max(1, height - top - (compact ? 3 : 10))
  const laneCount = mode === 'split' ? 3 : 1
  const laneHeight = plotHeight / laneCount
  const audioLeft = Math.max(0, Math.min(width, -start / span * width))
  const audioRight = Math.max(0, Math.min(width, (data.duration - start) / span * width))
  context.fillStyle = '#0c0f14'
  if (audioLeft > 0) context.fillRect(0, 0, audioLeft, height)
  if (audioRight < width) context.fillRect(audioRight, 0, width - audioRight, height)

  context.lineWidth = 1
  context.textBaseline = 'top'
  if (timeGrid) {
    const step = timelineStep(span, width)
    for (let time = Math.max(0, Math.ceil(start / step) * step); time <= Math.min(data.duration, end); time += step) {
      const x = (time - start) / span * width
      context.strokeStyle = 'rgba(170, 183, 214, 0.075)'
      context.beginPath()
      context.moveTo(x + 0.5, top)
      context.lineTo(x + 0.5, height)
      context.stroke()
    }
  }
  context.textAlign = 'left'

  for (let lane = 0; lane < laneCount; lane += 1) {
    const center = top + laneHeight * (lane + 0.5)
    context.strokeStyle = 'rgba(170, 183, 214, 0.12)'
    context.beginPath()
    context.moveTo(0, center + 0.5)
    context.lineTo(width, center + 0.5)
    context.stroke()
  }

  const levels = waveformLevels(data)
  const columns = Math.min(pixelWidth, 3_000)
  const columnWidth = width / columns
  const binsPerColumn = span / columns * data.binCount / data.duration
  const level = levels[Math.max(0, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(1, binsPerColumn / 2)))))]
  const binsPerSecond = data.binCount / data.duration / level.stride
  const colors = ['#ff5366', '#43e681', '#578bff']
  for (let column = 0; column < columns; column += 1) {
    const x = column * columnWidth
    if (x + columnWidth <= audioLeft || x >= audioRight) continue
    const first = Math.max(0, Math.min(level.binCount - 1, Math.floor((start + x / width * span) * binsPerSecond)))
    const last = Math.min(level.binCount, Math.max(first + 1, Math.ceil((start + (x + columnWidth) / width * span) * binsPerSecond)))
    let lowEnergy = 0
    let midEnergy = 0
    let highEnergy = 0
    let peak = 0
    for (let bin = first; bin < last; bin += 1) {
      lowEnergy += level.low[bin] ** 2
      midEnergy += level.mid[bin] ** 2
      highEnergy += level.high[bin] ** 2
      peak = Math.max(peak, level.peak[bin])
    }
    if (peak < 0.00001) continue
    const count = last - first
    const bands = [Math.sqrt(lowEnergy / count), Math.sqrt(midEnergy / count), Math.sqrt(highEnergy / count)]
    const strongest = Math.max(...bands, 0.00001)
    const left = Math.max(x, audioLeft)
    const barWidth = Math.min(x + columnWidth, audioRight) - left

    if (mode === 'rgb') {
      const center = top + laneHeight / 2
      // Display gains keep quieter mids and treble visible beside bass.
      // Height still follows the original peak, and each slice has one color.
      const displayBands = [bands[0], bands[1] * 2.8, bands[2] * 9]
      const brightest = Math.max(...displayBands, 0.00001)
      const rgb = displayBands.map((value) => Math.round(255 * Math.pow(value / brightest, 1.4)))
      context.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
      const amplitude = Math.pow(peak, 0.76) * laneHeight * 0.47
      context.fillRect(left, center - amplitude, barWidth, amplitude * 2)
    } else if (mode === 'bands') {
      const center = top + laneHeight / 2
      const extent = Math.pow(peak, 0.76) * laneHeight * 0.47
      const layers = bands.map((value, band) => ({ value, color: colors[band] }))
        .sort((a, b) => b.value - a.value)
      for (const layer of layers) {
        const amplitude = Math.pow(layer.value / strongest, 1.1) * extent
        context.fillStyle = layer.color
        context.fillRect(left, center - amplitude, barWidth, amplitude * 2)
      }
    } else {
      for (let lane = 0; lane < 3; lane += 1) {
        const center = top + laneHeight * (lane + 0.5)
        const amplitude = Math.pow(bands[lane], 0.72) * laneHeight * 0.43
        context.fillStyle = colors[lane]
        context.fillRect(left, center - amplitude, barWidth, amplitude * 2)
      }
    }
  }

  if (mode === 'split') {
    const names = ['LOW', 'MID', 'HIGH']
    context.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace'
    for (let lane = 0; lane < 3; lane += 1) {
      context.fillStyle = colors[lane]
      context.fillText(names[lane], 9, top + laneHeight * lane + 3)
    }
  }
}
