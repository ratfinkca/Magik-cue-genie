export const EQ_BANDS = ["low", "mid", "high"] as const
export const EQ_MIN_DB = -36
export const EQ_MAX_DB = 6
export type EqBand = typeof EQ_BANDS[number]
export type EqSettings = Record<EqBand, number>
type ChannelSettings = { filter: number; pan: number }

export function flatEq(): EqSettings {
  return { low: 0, mid: 0, high: 0 }
}

export function normalizeEqDb(db: number): number {
  return Number.isFinite(db) ? Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, db)) : 0
}

function normalizeSweep(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) : 0
}

export { normalizeSweep as normalizeFilter, normalizeSweep as normalizePan }

export function getChannelFilterFrequencies(value: number, sampleRate: number) {
  const sweep = normalizeSweep(value) / 100
  const nyquist = sampleRate / 2
  return {
    lowpass: sweep < 0 ? nyquist * (Math.min(180, nyquist) / nyquist) ** -sweep : nyquist,
    highpass: sweep > 0 ? Math.min(8_400, nyquist * .8) * Math.expm1(4 * sweep) / Math.expm1(4) : 0,
  }
}

interface FilterSettings {
  type: BiquadFilterType
  frequency: number
}

const filters: Record<EqBand, FilterSettings> = {
  low: { type: "lowshelf", frequency: 250 },
  mid: { type: "peaking", frequency: 1_000 },
  high: { type: "highshelf", frequency: 4_500 },
}

function makeFilters(context: BaseAudioContext, settings: EqSettings) {
  const makeFilter = (band: EqBand) => {
    const filter = context.createBiquadFilter()
    filter.type = filters[band].type
    filter.frequency.value = filters[band].frequency
    filter.gain.value = normalizeEqDb(settings[band])
    return filter
  }

  const nodes = { low: makeFilter("low"), mid: makeFilter("mid"), high: makeFilter("high") }
  nodes.mid.Q.value = .7
  return nodes
}

function makeChannelFilters(context: BaseAudioContext, value: number) {
  const frequencies = getChannelFilterFrequencies(value, context.sampleRate)
  const makeFilter = (type: "lowpass" | "highpass") => {
    const node = context.createBiquadFilter()
    node.type = type
    node.frequency.value = frequencies[type]
    node.Q.value = 0
    return node
  }
  return { lowpass: makeFilter("lowpass"), highpass: makeFilter("highpass") }
}

/** Plot the pre-crossfader channel response using the same EQ and sweep as playback. */
export function createEqResponseReader(sampleRate: number, frequencies: Float32Array) {
  const context = new OfflineAudioContext(1, 1, sampleRate)
  const nodes = makeFilters(context, flatEq())
  const sweep = makeChannelFilters(context, 0)
  const bins = new Float32Array(frequencies)
  const magnitude = new Float32Array(bins.length)
  const phase = new Float32Array(bins.length)
  return (settings: EqSettings, gainDb = 0, filter = 0) => {
    const result = new Float32Array(bins.length).fill(Number.isFinite(gainDb) ? gainDb : 0)
    const cutoffs = getChannelFilterFrequencies(filter, sampleRate)
    sweep.lowpass.frequency.value = cutoffs.lowpass
    sweep.highpass.frequency.value = cutoffs.highpass
    for (const band of EQ_BANDS) {
      nodes[band].gain.value = normalizeEqDb(settings[band])
    }
    // The passband endpoints are neutral. Skipping them also avoids frequency-response
    // singularities at DC and Nyquist on implementations that compute the endpoints.
    const filters = [...Object.values(nodes), ...(filter < 0 ? [sweep.lowpass] : filter > 0 ? [sweep.highpass] : [])]
    for (const node of filters) {
      node.getFrequencyResponse(bins, magnitude, phase)
      for (let i = 0; i < result.length; i++) result[i] += 20 * Math.log10(Math.max(1e-8, magnitude[i]))
    }
    return result
  }
}

export function createTransitionEq(context: BaseAudioContext, settings: EqSettings, channel?: ChannelSettings) {
  const nodes = makeFilters(context, settings)
  nodes.low.connect(nodes.mid)
  nodes.mid.connect(nodes.high)
  const sweep = channel && makeChannelFilters(context, channel.filter)
  const panner = channel && context.createStereoPanner()
  if (sweep && panner) {
    nodes.high.connect(sweep.lowpass)
    sweep.lowpass.connect(sweep.highpass)
    sweep.highpass.connect(panner)
    panner.pan.value = normalizeSweep(channel.pan) / 100
  }

  return {
    input: nodes.low,
    output: panner ?? nodes.high,
    setBand(band: EqBand, db: number) {
      nodes[band].gain.setTargetAtTime(normalizeEqDb(db), context.currentTime, .012)
    },
    setPan(value: number) {
      panner?.pan.setTargetAtTime(normalizeSweep(value) / 100, context.currentTime, .012)
    },
    setFilter(value: number) {
      if (!sweep) return
      const frequencies = getChannelFilterFrequencies(value, context.sampleRate)
      sweep.lowpass.frequency.setTargetAtTime(frequencies.lowpass, context.currentTime, .012)
      sweep.highpass.frequency.setTargetAtTime(frequencies.highpass, context.currentTime, .012)
    },
    disconnect() {
      for (const node of Object.values(nodes)) node.disconnect()
      sweep?.lowpass.disconnect()
      sweep?.highpass.disconnect()
      panner?.disconnect()
    },
  }
}
