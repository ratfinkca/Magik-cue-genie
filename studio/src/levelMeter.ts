export const METER_FLOOR_DB = -60

/** Sample peaks in dBFS, with levels above digital full scale left visible. */
export type StereoLevel = { left: number; right: number }
export type MixerLevels = { A: StereoLevel; B: StereoLevel; master: StereoLevel }

const silence = Object.freeze({ left: METER_FLOOR_DB, right: METER_FLOOR_DB })
export const SILENT_MIXER_LEVELS: MixerLevels = Object.freeze({ A: silence, B: silence, master: silence })

/** A passive tap that measures each channel without downmixing or changing the audible path. */
export function createStereoLevelMeter(context: BaseAudioContext, source: AudioNode) {
  const split = context.createChannelSplitter(2)
  const left = context.createAnalyser()
  const right = context.createAnalyser()
  left.fftSize = right.fftSize = 2048
  const samples = new Float32Array(left.fftSize)
  source.connect(split)
  split.connect(left, 0)
  split.connect(right, 1)

  function readDb(analyser: AnalyserNode) {
    analyser.getFloatTimeDomainData(samples)
    let peak = 0
    for (const sample of samples) {
      const magnitude = Math.abs(sample)
      if (magnitude > peak && Number.isFinite(magnitude)) peak = magnitude
    }
    return peak > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(peak)) : METER_FLOOR_DB
  }

  return {
    read: (): StereoLevel => ({ left: readDb(left), right: readDb(right) }),
    disconnect() {
      source.disconnect(split)
      split.disconnect()
    },
  }
}
