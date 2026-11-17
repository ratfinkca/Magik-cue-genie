import type { StretchNode } from "signalsmith-stretch"
import workletUrl from "signalsmith-stretch?url"
import { createStemMix, DECK_STEMS } from "./stemPlayback"
import type { DeckStemBank, DeckStemLevels } from "./stemPlayback"

type Loop = { start: number; end: number }

export interface KeyLockStart {
  at: number
  offset: number
  speed: number
  loop?: Loop | null
  excerptEnd?: number
  onEnd: () => void
  onError?: (error: Error) => void
}

export interface KeyLockSource {
  readonly node: AudioNode
  readonly latency: number
  start(options: KeyLockStart): void
  setRate(rate: number, at: number): void
  setLoop(range: Loop | null, at: number): void
  setStemLevels?(levels: DeckStemLevels): void
  stop(at: number): void
  dispose(): void
}

function inputAt(run: KeyLockStart, at: number): number {
  const time = run.offset + Math.max(0, at - run.at) * run.speed
  const { loop } = run
  if (!loop || time < loop.end) return time
  return loop.start + (time - loop.start) % (loop.end - loop.start)
}

async function stretchBuffer(buffer: AudioBuffer, rate: number,
  length = buffer.sampleRate === rate ? buffer.length : Math.round(buffer.duration * rate)): Promise<AudioBuffer> {
  const channels = Math.min(2, buffer.numberOfChannels)
  if (buffer.sampleRate === rate && buffer.length === length && channels === buffer.numberOfChannels) return buffer
  const render = new OfflineAudioContext(channels, length, rate)
  const input = render.createBufferSource()
  input.buffer = buffer
  input.connect(render.destination)
  input.start()
  return render.startRendering()
}

/** Load one bank of sampled audio into the local worklet for repeated seeks and rate changes. */
export async function prepareKeyLockSource(context: BaseAudioContext, buffer: AudioBuffer,
  stems?: DeckStemBank, signal?: AbortSignal): Promise<KeyLockSource> {
  signal?.throwIfAborted()
  if (!context.audioWorklet) throw new Error("Key Lock requires AudioWorklet support.")
  const [{ default: createStretchNode }, audio] = await Promise.all([
    import("signalsmith-stretch"), stretchBuffer(buffer, context.sampleRate),
  ])
  signal?.throwIfAborted()
  const count = stems ? 2 * (1 + DECK_STEMS.length) : audio.numberOfChannels
  createStretchNode.moduleUrl = workletUrl
  // Keep one disconnected input. Version 1.3.2 checks the input array even while idle.
  const stretch = await createStretchNode(context, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [count],
  })
  const routed: AudioNode[] = []
  const mix = stems && createStemMix(context)
  function disconnectRouting() {
    for (const node of routed) node.disconnect()
    mix?.disconnect()
  }
  try {
    signal?.throwIfAborted()
    const gate = context.createGain()
    gate.gain.value = 0
    const channels = Array.from({ length: stems ? 2 : audio.numberOfChannels }, (_, i) =>
      audio.getChannelData(Math.min(i, audio.numberOfChannels - 1)).slice())
    if (stems && mix) {
      // A single worklet processes all layers with one seek, loop and stretch clock.
      const splitter = context.createChannelSplitter(count)
      routed.push(splitter)
      stretch.connect(splitter)
      const inputs = [mix.original, ...mix.layers.map(layer => layer.input)]
      for (let index = 0; index < inputs.length; index++) {
        const stereo = context.createChannelMerger(2)
        routed.push(stereo)
        splitter.connect(stereo, index * 2, 0)
        splitter.connect(stereo, index * 2 + 1, 1)
        stereo.connect(inputs[index])
      }
      mix.output.connect(gate)
      for (const stem of DECK_STEMS) {
        const rendered = await stretchBuffer(stems[stem], context.sampleRate, audio.length)
        signal?.throwIfAborted()
        channels.push(rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice())
      }
    } else stretch.connect(gate)
    const [end, latency] = await Promise.all([
      stretch.addBuffers(channels, channels.map(channel => channel.buffer)), stretch.latency(),
    ])
    signal?.throwIfAborted()
    if (!Number.isFinite(latency) || latency < 0 || Math.abs(end - audio.duration) > .01) {
      throw new Error("Key Lock could not prepare the decoded track.")
    }
    const source = connectStretch(context, stretch, gate, buffer.duration, latency)
    if (!mix) return source
    return {
      ...source,
      setStemLevels: mix.setLevels,
      dispose() { source.dispose(); disconnectRouting() },
    }
  } catch (error) {
    disconnectRouting()
    stretch.disconnect()
    stretch.port.close()
    throw error
  }
}

function connectStretch(context: BaseAudioContext, stretch: StretchNode, gate: GainNode, duration: number,
  latency: number): KeyLockSource {
  let run: KeyLockStart | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failed = false

  function waitUntil(when: number, fire: () => void) {
    clearTimeout(timer)
    const remaining = when - context.currentTime
    if (remaining > 0.001) {
      timer = setTimeout(() => waitUntil(when, fire), Math.max(8, Math.min(250, remaining * 1000)))
    } else {
      timer = undefined
      fire()
    }
  }

  function silence(when: number) {
    gate.gain.cancelScheduledValues(when)
    gate.gain.setValueAtTime(0, when)
  }

  function fail() {
    if (disposed || failed) return
    failed = true
    const finished = run
    run = null
    clearTimeout(timer)
    silence(context.currentTime)
    finished?.onError?.(new Error("The Key Lock audio processor stopped unexpectedly."))
  }

  stretch.addEventListener("processorerror", fail)

  function schedule(options: Parameters<StretchNode["schedule"]>[0]) {
    try {
      void stretch.schedule(options).catch(fail)
    } catch {
      fail()
    }
  }

  function commit(next: KeyLockStart) {
    if (disposed || failed) throw new Error("The Key Lock audio processor is unavailable.")
    run = next
    clearTimeout(timer)
    const when = Math.max(next.at, context.currentTime)
    const offset = inputAt(next, when)
    const end = next.excerptEnd ?? (next.loop ? Infinity : duration)
    const endAt = when + Math.max(0, end - offset) / next.speed
    const audioOffset = Math.max(0, offset)
    const audioAt = when + (audioOffset - offset) / next.speed
    const hasAudio = end > audioOffset
    gate.gain.cancelScheduledValues(when)
    if (!hasAudio || audioAt > when) {
      gate.gain.setValueAtTime(0, when)
      // Clear any earlier pending onset when a tempo change moves sample zero.
      schedule({ output: when, active: false })
    }
    if (hasAudio) {
      gate.gain.setValueAtTime(1, audioAt)
      schedule({
        output: audioAt, input: audioOffset, rate: next.speed, semitones: 0, active: true,
        loopStart: next.loop?.start ?? 0, loopEnd: next.loop?.end ?? 0,
      })
    }
    if (Number.isFinite(endAt)) gate.gain.setValueAtTime(0, endAt)
    if (Number.isFinite(endAt)) waitUntil(endAt, () => {
      if (run !== next) return
      run = null
      schedule({ output: Math.max(endAt, context.currentTime), active: false })
      next.onEnd()
    })
  }

  return {
    node: gate,
    latency,
    start: commit,
    setRate(speed, at) {
      if (!run) return
      const when = Math.max(at, run.at, context.currentTime)
      commit({ ...run, offset: inputAt(run, when), at: when, speed })
    },
    setLoop(loop, at) {
      if (!run) return
      const when = Math.max(at, run.at, context.currentTime)
      commit({ ...run, offset: inputAt(run, when), at: when, loop })
    },
    stop(at) {
      if (disposed) return
      run = null
      const when = Math.max(at, context.currentTime)
      silence(when)
      waitUntil(when, () => schedule({ output: Math.max(when, context.currentTime), active: false }))
    },
    dispose() {
      if (disposed) return
      run = null
      disposed = true
      clearTimeout(timer)
      stretch.removeEventListener("processorerror", fail)
      gate.disconnect()
      stretch.disconnect()
      void stretch.dropBuffers().catch(() => {}).finally(() => stretch.port.close())
    },
  }
}
