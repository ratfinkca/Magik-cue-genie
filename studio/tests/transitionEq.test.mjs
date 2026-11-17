import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/transitionEq.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { createTransitionEq, createEqResponseReader, EQ_MIN_DB, flatEq, getChannelFilterFrequencies } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function audioGraph() {
  const nodes = []
  return {
    currentTime: 4,
    sampleRate: 48_000,
    nodes,
    createBiquadFilter() {
      const targets = []
      const node = {
        frequency: { value: 0, targets: [], setTargetAtTime(...args) { this.targets.push(args) } },
        Q: { value: 0 },
        gain: {
          value: 0,
          targets,
          setTargetAtTime(...args) { targets.push(args) },
        },
        outputs: [],
        connect(output) { this.outputs.push(output) },
        disconnect() { this.outputs.length = 0 },
      }
      nodes.push(node)
      return node
    },
    createStereoPanner() {
      return { pan: { value: 0, targets: [], setTargetAtTime(...args) { this.targets.push(args) } }, disconnect() {} }
    },
  }
}

test('flat EQ routes all three frequency bands through independent zero-gain filters', () => {
  const context = audioGraph()
  const chain = createTransitionEq(context, flatEq())
  const [low, mid, high] = context.nodes
  assert.equal(chain.input, low)
  assert.equal(chain.output, high)
  assert.deepEqual(context.nodes.map(node => node.type), ['lowshelf', 'peaking', 'highshelf'])
  assert.deepEqual(context.nodes.map(node => node.gain.value), [0, 0, 0])
  assert.ok(low.frequency.value < mid.frequency.value && mid.frequency.value < high.frequency.value)
  assert.deepEqual(low.outputs, [mid])
  assert.deepEqual(mid.outputs, [high])
  chain.disconnect()
  assert.ok(context.nodes.every(node => node.outputs.length === 0))
})

test('live bass cut is bounded and automated only on the selected deck and band', () => {
  const context = audioGraph()
  const deckA = createTransitionEq(context, flatEq())
  createTransitionEq(context, { ...flatEq(), low: -4 })

  deckA.setBand('low', -100)
  const [timeTarget] = context.nodes[0].gain.targets
  assert.equal(timeTarget[0], EQ_MIN_DB)
  assert.equal(timeTarget[1], context.currentTime)
  assert.ok(timeTarget[2] > 0 && timeTarget[2] < 0.05)
  assert.ok(context.nodes.slice(1).every(node => node.gain.targets.length === 0))
  assert.equal(context.nodes[3].gain.value, -4)
})

test('the channel sweep uses opposite filter slopes and smooths movement downstream of EQ', () => {
  const ctx = audioGraph()
  const chain = createTransitionEq(ctx, flatEq(), { filter: 0, pan: -40 })
  const [,, high, lowpass, highpass] = ctx.nodes
  assert.equal(lowpass.type, 'lowpass')
  assert.equal(highpass.type, 'highpass')
  assert.equal(lowpass.frequency.value, 24_000)
  assert.equal(highpass.frequency.value, 0)
  assert.deepEqual(high.outputs, [lowpass])
  assert.deepEqual(lowpass.outputs, [highpass])
  assert.deepEqual(highpass.outputs, [chain.output])
  assert.equal(chain.output.pan.value, -.4)
  const low = getChannelFilterFrequencies(-60, ctx.sampleRate)
  const highCut = getChannelFilterFrequencies(60, ctx.sampleRate)
  assert.ok(low.lowpass > 0 && low.lowpass < 24_000)
  assert.equal(low.highpass, 0)
  assert.ok(highCut.highpass > 0)
  assert.equal(highCut.lowpass, 24_000)
  chain.setPan(100)
  chain.setFilter(60)
  assert.equal(chain.output.pan.targets[0][0], 1)
  assert.equal(highpass.frequency.targets[0][0], highCut.highpass)
  assert.equal(highpass.frequency.targets[0][1], 4)
})

test('channel response adds the same trim at each plotted frequency', () => {
  const original = globalThis.OfflineAudioContext
  globalThis.OfflineAudioContext = class {
    constructor() { this.sampleRate = 48_000 }
    createBiquadFilter() {
      return { frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 },
        getFrequencyResponse(_, magnitude) { magnitude.fill(10 ** (this.gain.value / 20)) } }
    }
  }
  try {
    const response = createEqResponseReader(48_000, Float32Array.of(125, 1_000, 8_000))
    const eq = { ...flatEq(), low: -6 }
    const reference = response(eq)
    const diff = gain => Array.from(response(eq, gain).map((db, i) => db - reference[i]))
    assert.deepEqual(diff(18), [18, 18, 18])
    assert.deepEqual(diff(-60), [-60, -60, -60])
  } finally {
    if (original) globalThis.OfflineAudioContext = original
    else delete globalThis.OfflineAudioContext
  }
})
