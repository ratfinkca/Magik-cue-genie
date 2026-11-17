import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/transitionFx.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { createDeckEffects, deckFxTailSeconds, DEFAULT_DECK_FX, normalizeDeckFx } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function audioGraph() {
  const nodes = []
  function node(param) {
    const next = {
      outputs: [],
      connections: [],
      [param]: { value: 0, targets: [], setTargetAtTime(...args) { this.targets.push(args) } },
      connect(output, from = 0, to = 0) { this.outputs.push(output); this.connections.push({ output, from, to }) },
      disconnect() { this.outputs.length = 0; this.connections.length = 0 },
    }
    nodes.push(next)
    return next
  }
  return {
    currentTime: 0,
    sampleRate: 48_000,
    nodes,
    createGain() { return node('gain') },
    createDelay(maxDelayTime) { return Object.assign(node('delayTime'), { maxDelayTime }) },
    createChannelMerger(channels) { return Object.assign(node('merger'), { channels }) },
    createBuffer(channels, frames, sampleRate) {
      const samples = Array.from({ length: channels }, () => new Float32Array(frames))
      return { duration: frames / sampleRate, numberOfChannels: channels, getChannelData: channel => samples[channel] }
    },
    createConvolver() { return Object.assign(node('normalize'), { buffer: null }) },
    createBiquadFilter() { return Object.assign(node('frequency'), { Q: { value: 1 } }) },
    createOscillator() {
      return Object.assign(node('frequency'), { starts: 0, stops: 0, start() { this.starts++ }, stop() { this.stops++ } })
    },
  }
}

test('deck FX restores safe defaults and bounds saved mixes, delay times and feedback', () => {
  assert.deepEqual(normalizeDeckFx(null), DEFAULT_DECK_FX)
  assert.deepEqual(normalizeDeckFx({ enabled: 1, mix: NaN, delayMs: '200', feedback: Infinity }), DEFAULT_DECK_FX)
  assert.deepEqual(normalizeDeckFx({ enabled: true, mix: 110, delayMs: 4, feedback: 150 }), {
    ...DEFAULT_DECK_FX,
    enabled: true, mix: 100, delayMs: 60, feedback: 70,
  })
  assert.deepEqual(normalizeDeckFx({ enabled: true, mix: -2, delayMs: 2_000, feedback: -1 }), {
    ...DEFAULT_DECK_FX,
    enabled: true, mix: 0, delayMs: 1_000, feedback: 0,
  })
  const saved = normalizeDeckFx({ kind: 'room', roomPredelayMs: 130, roomDamping: -4, tremoloRateHz: -5, tremoloDepth: 160 })
  assert.deepEqual(saved, { ...DEFAULT_DECK_FX, kind: 'room', roomPredelayMs: 90, roomDamping: 0, tremoloRateHz: .5, tremoloDepth: 100 })
  assert.equal(normalizeDeckFx({ kind: 'bad' }).kind, 'echo')
  assert.deepEqual(normalizeDeckFx({ kind: 'flanger', flangerRateHz: 0, flangerDepth: 120 }), {
    ...DEFAULT_DECK_FX, kind: 'flanger', flangerRateHz: .05, flangerDepth: 100,
  })
})

test('bypass routes the dry signal at unity and releases all connections on teardown', () => {
  const context = audioGraph()
  const fx = createDeckEffects(context, DEFAULT_DECK_FX)
  const [input, dry, output] = context.nodes
  assert.equal(fx.input, input)
  assert.equal(fx.output, output)
  assert.deepEqual(input.outputs, [dry])
  assert.equal(dry.gain.value, 1)
  assert.deepEqual(dry.outputs, [output])
  assert.equal(context.nodes.length, 3)
  fx.update({ ...DEFAULT_DECK_FX, enabled: true })
  const [,,, send, wet, delay, feedback] = context.nodes
  assert.deepEqual(input.outputs, [dry, send])
  assert.deepEqual(dry.outputs, [output])
  assert.deepEqual(send.outputs, [delay])
  assert.deepEqual(delay.outputs, [feedback, wet])
  assert.deepEqual(feedback.outputs, [delay])
  assert.deepEqual(wet.outputs, [output])
  assert.equal(delay.maxDelayTime, 1)
  assert.equal(delay.delayTime.value, .375)
  assert.deepEqual([send, feedback, wet].map(node => node.gain.value), [0, 0, 0])
  fx.disconnect()
  assert.ok(context.nodes.every(node => node.outputs.length === 0))
})

test('automated feedback repeats decay and switching off smoothly mutes only that deck', () => {
  const context = audioGraph()
  const deck = createDeckEffects(context, DEFAULT_DECK_FX)
  context.currentTime = 3
  deck.update({ ...DEFAULT_DECK_FX, enabled: true, mix: 50, delayMs: 725, feedback: 95 })
  const [, dry,, send, wet, delay, feedback] = context.nodes
  createDeckEffects(context, DEFAULT_DECK_FX)
  const dryGain = dry.gain.targets[0][0]
  const loopGain = feedback.gain.targets[0][0]
  const wetGain = wet.gain.targets[0][0]
  assert.equal(dryGain, .5)
  assert.equal(send.gain.targets[0][0], 1)
  assert.equal(delay.delayTime.targets[0][0], .725)
  assert.equal(loopGain, .7)
  const normalizedTotal = dryGain + wetGain / (1 - loopGain)
  assert.ok(Math.abs(normalizedTotal - 1) < 1e-12)
  const repeats = Array.from({ length: 6 }, (_, i) => wetGain * loopGain ** i)
  assert.ok(repeats.every((gain, i) => i === 0 || gain < repeats[i - 1]))
  for (const [_, timestamp, smoothing] of [dry.gain, send.gain, delay.delayTime, feedback.gain, wet.gain]
    .map(param => param.targets[0])) {
    assert.equal(timestamp, 3)
    assert.ok(smoothing > 0 && smoothing < .06)
  }
  context.currentTime = 5
  deck.update({ ...DEFAULT_DECK_FX, enabled: false, mix: 50, delayMs: 725, feedback: 70 })
  assert.deepEqual([dry, send, feedback, wet].map(node => node.gain.targets.at(-1)[0]), [1, 0, 0, 0])
  assert.ok(context.nodes.slice(7).every(node => (node.gain ?? node.delayTime).targets.length === 0))
})

test('room uses a decaying stereo impulse and crossfades to independent amplitude modulation', () => {
  const context = audioGraph()
  const roomSettings = { ...DEFAULT_DECK_FX, kind: 'room', enabled: true, mix: 100, roomPredelayMs: 26, roomDamping: 100 }
  const deck = createDeckEffects(context, roomSettings)
  const [input, dry, output, roomSend, roomWet, predelay, room, damping] = context.nodes
  assert.equal(dry.gain.value, 0)
  assert.deepEqual(input.outputs, [dry, roomSend])
  assert.deepEqual(roomSend.outputs, [predelay])
  assert.deepEqual(predelay.outputs, [room])
  assert.deepEqual(room.outputs, [damping])
  assert.deepEqual(damping.outputs, [roomWet])
  assert.deepEqual(roomWet.outputs, [output])
  assert.equal(predelay.delayTime.value, .026)
  assert.equal(damping.frequency.value, 1_200)
  assert.equal(room.buffer.numberOfChannels, 2)
  assert.equal(room.buffer.duration, 1.3)
  const left = room.buffer.getChannelData(0)
  const right = room.buffer.getChannelData(1)
  function energy(samples, from, to) {
    return samples.subarray(from, to).reduce((sum, value) => sum + value ** 2, 0)
  }
  assert.ok(left.some((sample, frame) => Math.abs(sample - right[frame]) > .01))
  assert.ok(energy(left, 0, 16_000) > 100 * energy(left, 46_400, 62_400))

  context.currentTime = 5
  const tremoloSettings = { ...roomSettings, kind: 'tremolo', mix: 50, tremoloRateHz: 8, tremoloDepth: 60 }
  deck.update(tremoloSettings)
  const [tremoloSend, tremoloWet, amplitude, depth, lfo] = context.nodes.slice(8)
  assert.equal(roomWet.gain.targets[0][0], 0)
  assert.equal(roomSend.gain.targets[0][0], 0)
  assert.equal(tremoloWet.gain.targets[0][0], .5)
  assert.deepEqual(tremoloSend.outputs, [amplitude])
  assert.deepEqual(lfo.outputs, [depth])
  assert.deepEqual(depth.outputs, [amplitude.gain])
  assert.equal(amplitude.gain.targets[0][0], .7)
  assert.equal(depth.gain.targets[0][0], .3)
  assert.equal(lfo.frequency.value, 8)
  assert.equal(lfo.starts, 1)
  deck.update({ ...tremoloSettings, mix: 0 })
  assert.equal(dry.gain.targets.at(-1)[0], 1)
  assert.equal(tremoloWet.gain.targets.at(-1)[0], 0)
  assert.equal(tremoloSend.gain.targets.at(-1)[0], 0)
  assert.equal(deckFxTailSeconds(tremoloSettings), 0)
  assert.ok(deckFxTailSeconds(roomSettings) > room.buffer.duration)
  assert.equal(deckFxTailSeconds({ ...DEFAULT_DECK_FX, enabled: true, feedback: 0 }), .375)
  assert.equal(deckFxTailSeconds(DEFAULT_DECK_FX), 0)
  deck.disconnect()
  assert.equal(lfo.stops, 1)
  assert.ok(context.nodes.every(node => node.outputs.length === 0))
})

test('Ping Pong alternates stereo channels without changing Echo settings', () => {
  const context = audioGraph()
  const settings = { ...DEFAULT_DECK_FX, kind: 'pingPong', enabled: true, mix: 50, pingPongDelayMs: 240, pingPongFeedback: 50 }
  const deck = createDeckEffects(context, settings)
  const [, dry, output, send, wet, mono, left, right, leftToRight, rightToLeft, stereo] = context.nodes
  assert.equal(mono.channelCount, 1)
  assert.equal(mono.channelCountMode, 'explicit')
  assert.deepEqual(send.outputs, [mono])
  assert.deepEqual(mono.outputs, [left])
  assert.deepEqual(left.connections, [{ output: stereo, from: 0, to: 0 }, { output: leftToRight, from: 0, to: 0 }])
  assert.deepEqual(right.connections, [{ output: stereo, from: 0, to: 1 }, { output: rightToLeft, from: 0, to: 0 }])
  assert.deepEqual(leftToRight.outputs, [right])
  assert.deepEqual(rightToLeft.outputs, [left])
  assert.deepEqual(stereo.outputs, [wet])
  assert.deepEqual(wet.outputs, [output])
  assert.deepEqual([left.delayTime.value, right.delayTime.value], [.24, .24])
  assert.deepEqual([dry.gain.value, wet.gain.value, leftToRight.gain.value, rightToLeft.gain.value], [.5, .25, .5, .5])
  assert.equal(deckFxTailSeconds({ ...settings, pingPongFeedback: 0 }), .24)
  deck.update({ ...settings, kind: 'echo' })
  assert.equal(wet.gain.targets.at(-1)[0], 0)
  assert.equal(context.nodes.at(-2).delayTime.value, .375)
  deck.disconnect()
  assert.ok(context.nodes.every(node => node.outputs.length === 0))
})

test('Flanger sweeps a short delay, becomes transparent at zero depth and stops its oscillator', () => {
  const context = audioGraph()
  const settings = { ...DEFAULT_DECK_FX, kind: 'flanger', enabled: true, mix: 100, flangerRateHz: .75, flangerDepth: 100 }
  const deck = createDeckEffects(context, settings)
  const [, dry,, send, wet, input, direct, delayed, output, delay, modulation, lfo] = context.nodes
  assert.deepEqual(send.outputs, [input])
  assert.deepEqual(input.outputs, [direct, delay])
  assert.deepEqual(delay.outputs, [delayed])
  assert.deepEqual(direct.outputs, delayed.outputs)
  assert.deepEqual(output.outputs, [wet])
  assert.deepEqual(lfo.outputs, [modulation])
  assert.deepEqual(modulation.outputs, [delay.delayTime])
  assert.equal(lfo.frequency.value, .75)
  assert.equal(lfo.starts, 1)
  assert.equal(modulation.gain.value, .0035)
  assert.equal(dry.gain.value, 0)
  assert.equal(direct.gain.value, .5)
  assert.equal(delayed.gain.value, .5)
  deck.update({ ...settings, flangerDepth: 0 })
  assert.equal(direct.gain.targets.at(-1)[0], 1)
  assert.equal(delayed.gain.targets.at(-1)[0], 0)
  deck.disconnect()
  assert.equal(lfo.stops, 1)
})
