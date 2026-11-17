/** Entirely generated demo audio; no recordings, downloads, or sample packs. */
export const DEMO_NAME = 'Night Signal.wav'
export const DEMO_BPM = 120
export const DEMO_DURATION = 32

export function createDemoBuffer(context: BaseAudioContext): AudioBuffer {
  const sampleRate = 44_100
  const buffer = context.createBuffer(2, sampleRate * DEMO_DURATION, sampleRate)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const tau = Math.PI * 2
  let seed = 0x6d616769
  const noise = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) / 0xffffffff) * 2 - 1
  }
  const add = (start: number, duration: number, voice: (time: number) => number, pan = 0) => {
    const first = Math.round(start * sampleRate)
    const count = Math.min(Math.ceil(duration * sampleRate), left.length - first)
    const leftGain = Math.sqrt((1 - pan) / 2)
    const rightGain = Math.sqrt((1 + pan) / 2)
    for (let index = 0; index < count; index++) {
      const value = voice(index / sampleRate)
      left[first + index] += value * leftGain
      right[first + index] += value * rightGain
    }
  }
  const chords = [
    [130.813, 155.563, 195.998], // C minor
    [103.826, 130.813, 155.563], // A flat
    [155.563, 195.998, 233.082], // E flat
    [116.541, 146.832, 174.614], // B flat
  ]

  // Sixteen 4/4 bars: sparse intro, growing build, strongest drop, thinning outro.
  for (let bar = 0; bar < 16; bar++) {
    const start = bar * 2
    const section = Math.floor(bar / 4)
    const chord = chords[bar % chords.length]
    const full = section === 2
    const building = section === 1
    const outro = section === 3
    const progress = (bar % 4) / 3
    add(start, 2.05, (time) => {
      const envelope = Math.min(1, time / 0.08) * Math.max(0, 1 - time / 2.05)
      return chord.reduce((sum, pitch) => sum + Math.sin(tau * pitch * time), 0)
        * envelope * (full ? 0.065 : outro ? 0.04 * (1 - progress * 0.5) : 0.035)
    }, bar % 2 ? 0.2 : -0.2)

    for (let beat = 0; beat < 4; beat++) {
      const at = start + beat * 0.5
      if (!outro || bar < 15) {
        add(at, 0.34, (time) => {
          const phase = tau * (47 * time + 85 * 0.025 * (1 - Math.exp(-time / 0.025)))
          const level = full ? 0.85 : building ? 0.5 + progress * 0.12 : outro ? 0.48 * (1 - progress * 0.65) : 0.45
          return Math.sin(phase) * Math.exp(-time * 17) * Math.min(1, time / 0.002) * level
        })
      }
      if (!outro || beat % 2 === 0) {
        add(at + 0.035, 0.37, (time) => {
          const frequency = chord[0] / 2 * (beat === 3 && full ? 2 : 1)
          const envelope = Math.min(1, time / 0.012) * Math.exp(-time * 6) * Math.min(1, (0.37 - time) / 0.03)
          return (Math.sin(tau * frequency * time) + 0.2 * Math.sin(tau * frequency * 2 * time))
            * envelope * (full ? 0.29 : building ? 0.15 + progress * 0.05 : outro ? 0.12 * (1 - progress * 0.7) : 0.12)
        })
      }
      if ((full || building || (outro && bar < 14)) && beat % 2 === 1) {
        add(at, 0.18, (time) => (noise() * 0.18 + Math.sin(tau * 180 * time) * 0.08)
          * Math.exp(-time * 25) * Math.min(1, time / 0.002) * (full ? 1 : building ? 0.65 : 0.4), -0.08)
      }
      for (let eighth = 0; eighth < 2; eighth++) {
        if (outro && eighth === 0) continue
        let previousNoise = 0
        add(at + eighth * 0.25, 0.055, (time) => {
          const nextNoise = noise()
          const highPassed = nextNoise - previousNoise
          previousNoise = nextNoise
          return highPassed * Math.exp(-time * 85) * (full ? 0.065 : building ? 0.035 + progress * 0.02 : 0.023)
        }, eighth ? 0.45 : -0.35)
      }
    }
    if (full || building || outro) {
      for (let note = 0; note < (outro ? 4 : 8); note++) {
        const frequency = chord[[0, 1, 2, 1, 0, 2, 1, 2][note]] * 2
        add(start + note * (outro ? 0.5 : 0.25), 0.23, (time) => {
          const envelope = Math.min(1, time / 0.006) * Math.exp(-time * 16)
          return (Math.sin(tau * frequency * time) + Math.sin(tau * frequency * 2 * time) * 0.18)
            * envelope * (full ? 0.105 : building ? 0.05 + progress * 0.03 : 0.05 * (1 - progress * 0.7))
        }, note % 2 ? 0.4 : -0.4)
      }
    }
  }
  add(14, 2, (time) => noise() * (time / 2) ** 2 * 0.035, 0.1)

  // Bounded output with a short entrance and a smooth final release.
  for (let index = 0; index < left.length; index++) {
    const time = index / sampleRate
    const fade = Math.min(1, time / 0.035, (DEMO_DURATION - time) / 0.35)
    left[index] = Math.tanh(left[index]) * 0.82 * fade
    right[index] = Math.tanh(right[index]) * 0.82 * fade
  }
  return buffer
}
