import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Render the actual package's AudioWorklet processor and WASM without relying
// on access to an audio device or a running browser in the unit test runner.
const entry = new URL(import.meta.resolve('signalsmith-stretch'))
const worklet = (await readFile(entry, 'utf8')).replace('export default _export;', '')
const sampleRate = 48_000
const quantum = 128

function tone(frequency, seconds) {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, frame) =>
    0.25 * Math.sin(2 * Math.PI * frequency * frame / sampleRate))
}

function strongestFrequency(samples, begin, end) {
  const sample = samples.subarray(Math.ceil(sampleRate * begin), Math.floor(sampleRate * end))
  let best = { frequency: 0, power: 0 }
  for (let frequency = 380; frequency <= 620; frequency++) {
    const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate)
    let previous = 0
    let beforePrevious = 0
    for (const value of sample) {
      const current = value + coefficient * previous - beforePrevious
      beforePrevious = previous
      previous = current
    }
    const power = beforePrevious ** 2 + previous ** 2 - coefficient * previous * beforePrevious
    if (power > best.power) best = { frequency, power }
  }
  assert.ok(best.power > 1, 'a real tone was present in the output')
  return best.frequency
}

async function renderStretched(samples, schedule, seconds) {
  const banks = Array.isArray(samples) ? samples : [samples]
  let Processor
  let ready
  const sandbox = vm.createContext({
    sampleRate,
    currentTime: 0,
    performance,
    crypto: globalThis.crypto,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: ([event]) => { if (event === 'ready') ready() } }
      }
    },
    registerProcessor(name, ctor) { Processor = ctor },
  })
  vm.runInContext(worklet, sandbox)
  const workletReady = new Promise(resolve => { ready = resolve })
  const processor = new Processor({ numberOfOutputs: 1, outputChannelCount: [banks.length] })
  await workletReady
  processor.port.onmessage({ data: [1, 'addBuffers', banks] })
  processor.port.onmessage({ data: [2, 'schedule', schedule] })

  const length = Math.ceil(seconds * sampleRate / quantum) * quantum
  const output = banks.map(() => new Float32Array(length))
  for (let frame = 0; frame < length; frame += quantum) {
    sandbox.currentTime = frame / sampleRate
    processor.process([[]], [output.map(channel => channel.subarray(frame, frame + quantum))], {})
  }
  return Array.isArray(samples) ? output : output[0]
}

test('local stretch changes a synthetic track to 125% tempo while preserving its pitch', async () => {
  const input = tone(440, 4)
  const rate = 1.25
  const locked = await renderStretched(input, { active: true, input: 0.2, output: 0.2, rate, semitones: 0 }, 2)
  const unlocked = Float32Array.from({ length: 2 * sampleRate }, (_, i) => {
    const position = i * rate
    const before = Math.floor(position)
    return input[before] + (input[before + 1] - input[before]) * (position - before)
  })
  assert.ok(Math.abs(strongestFrequency(locked, 0.8, 1.6) - 440) <= 2)
  assert.ok(Math.abs(strongestFrequency(unlocked, 0.8, 1.6) - 550) <= 2)
})

test('locked playback also advances through the sample bank at the requested tempo', async () => {
  const input = tone(440, 4)
  input.set(tone(600, 2), sampleRate * 2)
  const locked = await renderStretched(input, { active: true, input: 0.2, output: 0.2, rate: 1.25, semitones: 0 }, 2.4)
  assert.ok(Math.abs(strongestFrequency(locked, 1, 1.45) - 440) <= 2)
  // Input reaches 2 s at 1.64 s of output; at native speed it would take 2 s.
  assert.ok(Math.abs(strongestFrequency(locked, 1.79, 1.97) - 600) <= 2)
})

test('one Key Lock worklet keeps ten aligned stem channels in phase through a loop', async () => {
  const input = tone(440, 4)
  input.set(tone(600, 2), sampleRate * 2)
  const gains = [1, .8, .5, .6, .7, .4, .3, .2, .1, .9]
  const channels = await renderStretched(gains.map(gain => input.map(sample => sample * gain)),
    { active: true, input: .3, output: .2, rate: 1.25, semitones: 0, loopStart: .3, loopEnd: 2.6 }, 2.6)
  const start = Math.floor(.8 * sampleRate), end = Math.floor(2.5 * sampleRate)
  let referenceEnergy = 0
  for (let frame = start; frame < end; frame++) referenceEnergy += channels[0][frame] ** 2
  assert.ok(referenceEnergy > 100)
  for (let channel = 1; channel < channels.length; channel++) {
    let error = 0
    for (let frame = start; frame < end; frame++) error += (channels[channel][frame] - channels[0][frame] * gains[channel]) ** 2
    assert.ok(error / referenceEnergy < 1e-6, `stem channel ${channel} drifted or leaked`)
  }
})

test('rate and loop changes during a pending launch retain its timestamp and input', async () => {
  const mockPackage = 'data:text/javascript,' + encodeURIComponent('export default context => context.testStretch')
  const stemSource = await readFile(new URL('../src/stemPlayback.ts', import.meta.url), 'utf8')
  const stemJavaScript = ts.transpileModule(stemSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const stemModule = 'data:text/javascript;base64,' + Buffer.from(stemJavaScript).toString('base64')
  const adapter = (await readFile(new URL('../src/keyLock.ts', import.meta.url), 'utf8'))
    .replace('import workletUrl from "signalsmith-stretch?url"', 'const workletUrl = "./test.mjs"')
    .replaceAll('from "./stemPlayback"', `from ${JSON.stringify(stemModule)}`)
    .replace('import("signalsmith-stretch")', `import(${JSON.stringify(mockPackage)})`)
  const javascript = ts.transpileModule(adapter, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const { prepareKeyLockSource } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

  const scheduled = []
  const envelope = []
  const stretch = new EventTarget()
  stretch.addBuffers = async () => 4
  stretch.latency = async () => 0.12
  stretch.schedule = async options => scheduled.push(options)
  stretch.dropBuffers = async () => {}
  stretch.port = { close() {} }
  stretch.connect = () => {}
  stretch.disconnect = () => {}
  const context = {
    audioWorklet: {}, testStretch: stretch, currentTime: 0.2, sampleRate,
    createGain: () => ({
      gain: {
        value: 0,
        cancelScheduledValues(when) { envelope.push(['cancel', when]) },
        setValueAtTime(gain, when) { envelope.push([gain, when]) },
      },
      disconnect() {},
    }),
  }
  const buffered = tone(440, 4)
  const source = await prepareKeyLockSource(context, {
    sampleRate, length: buffered.length, duration: 4, numberOfChannels: 1, getChannelData: () => buffered,
  })
  try {
    assert.equal(source.latency, 0.12)
    source.start({ at: 0.5, offset: 1.5, speed: 1, excerptEnd: 2.5, onEnd() {} })
    source.setRate(1.25, 0.2)
    assert.deepEqual(envelope.slice(-3), [['cancel', 0.5], [1, 0.5], [0, 1.3]])
    source.setLoop({ start: 1.3, end: 2.7 }, 0.2)
    assert.deepEqual(scheduled.at(-1), {
      output: 0.5, input: 1.5, rate: 1.25, active: true, semitones: 0, loopStart: 1.3, loopEnd: 2.7,
    })
    context.currentTime = 0.7
    source.setRate(1.5, 0.7)
    assert.ok(Math.abs(scheduled.at(-1).input - 1.75) < 0.0001)
    assert.equal(scheduled.at(-1).output, 0.7)
    assert.equal(scheduled.at(-1).rate, 1.5)

    context.currentTime = 1
    source.start({ at: 1, offset: -2, speed: 1, excerptEnd: 1, onEnd() {} })
    assert.deepEqual(envelope.slice(-4), [['cancel', 1], [0, 1], [1, 3], [0, 4]])
    assert.equal(scheduled.at(-1).input, 0)
    assert.equal(scheduled.at(-1).output, 3)
    context.currentTime = 1.5
    source.setRate(.5, 1.5)
    assert.deepEqual(envelope.slice(-4), [['cancel', 1.5], [0, 1.5], [1, 4.5], [0, 6.5]])
    assert.equal(scheduled.at(-1).input, 0)
    assert.equal(scheduled.at(-1).output, 4.5)
  } finally {
    source.dispose()
  }
})
