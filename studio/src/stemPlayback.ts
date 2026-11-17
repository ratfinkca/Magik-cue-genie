export const DECK_STEMS = ["vocals", "drums", "bass", "other"] as const
export type DeckStem = typeof DECK_STEMS[number]
export type DeckStemBank = Record<DeckStem, AudioBuffer>
export type DeckStemLevels = Readonly<Record<DeckStem, number>>
export type DeckStemStatus = "idle" | "restoring" | "preparing" | "ready" | "error"
export const FULL_STEM_LEVELS: DeckStemLevels = Object.freeze({ vocals: 100, drums: 100, bass: 100, other: 100 })

/** The full mix and selected stems share the same stereo output and transport. */
export function createStemMix(context: BaseAudioContext, initialLevels = FULL_STEM_LEVELS) {
  const output = context.createGain()
  const original = context.createGain()
  const layers = DECK_STEMS.map(stem => ({ stem, input: context.createGain() }))
  for (const input of [original, ...layers.map(layer => layer.input)]) input.connect(output)

  function setLevels(levels: DeckStemLevels, immediate = false) {
    const now = context.currentTime
    function set(input: GainNode, value: number) {
      if (immediate) input.gain.value = value
      else input.gain.setTargetAtTime(value, now, .008)
    }
    const fullMix = DECK_STEMS.every(stem => levels[stem] === 100)
    set(original, fullMix ? 1 : 0)
    for (const { stem, input } of layers) set(input, fullMix ? 0 : levels[stem] / 100)
  }

  setLevels(initialLevels, true)
  return {
    original, layers, output, setLevels,
    disconnect() {
      for (const input of [original, ...layers.map(layer => layer.input), output]) input.disconnect()
    },
  }
}

type Loop = { start: number; end: number }

/** Schedule every voice from the same deck time and decoded track offset. */
export function createNativeStemSource(context: AudioContext, buffer: AudioBuffer, stems?: DeckStemBank,
  levels = FULL_STEM_LEVELS) {
  const original = context.createBufferSource()
  original.buffer = buffer
  const mix = stems && createStemMix(context, levels)
  const voices = [original]
  if (stems && mix) {
    original.connect(mix.original)
    for (const { stem, input } of mix.layers) {
      const node = context.createBufferSource()
      node.buffer = stems[stem]
      node.connect(input)
      voices.push(node)
    }
  }

  function setLoop(loop: Loop | null) {
    for (const voice of voices) {
      voice.loopStart = loop?.start ?? 0
      voice.loopEnd = loop?.end ?? 0
      voice.loop = Boolean(loop)
    }
  }

  return {
    node: mix?.output ?? original,
    start(at: number, offset: number, duration: number | undefined, rate: number, loop: Loop | null) {
      setLoop(loop)
      for (const voice of voices) {
        voice.playbackRate.value = rate
        voice.start(at, offset, duration)
      }
    },
    setRate(rate: number, at: number) {
      for (const voice of voices) voice.playbackRate.setValueAtTime(rate, at)
    },
    setLoop,
    setLevels: mix?.setLevels,
    onEnded(callback: () => void) { original.onended = callback },
    stop(at: number) { for (const voice of voices) voice.stop(at) },
    disconnect() {
      if (!mix) return
      for (const voice of voices) voice.disconnect()
      mix.disconnect()
    },
  }
}
