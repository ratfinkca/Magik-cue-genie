import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

async function load(module) {
  const source = await readFile(new URL(`../src/${module}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

const { controllerPresets, detectControllerPreset } = await load('controllerPresets')
const { studioMidiTargets } = await load('studioMidiTargets')
const flx4 = controllerPresets.find(preset => preset.id === 'ddj-flx4')
const mixstream = controllerPresets.find(preset => preset.id === 'mixstream-pro-go')

function control(preset, actionId) {
  return preset.bindings.find(binding => binding.actionId === actionId)?.control
}

test('model detection accepts controller port names and excludes neighboring models', () => {
  for (const name of ['DDJ-FLX4', 'Pioneer DJ DDJ FLX4 MIDI', 'DDJFLX4']) {
    assert.equal(detectControllerPreset({ name, manufacturer: 'AlphaTheta' }), flx4)
  }
  for (const name of ['Mixstream Pro Go', 'NUMARK MIXSTREAM PRO GO MIDI 1', 'MixstreamProGo']) {
    assert.equal(detectControllerPreset({ name, manufacturer: 'Numark' }), mixstream)
  }
  for (const name of ['DDJ-FLX40', 'DDJ-FLX6', 'Mixstream Pro', 'Mixstream Pro+', 'Mixstream Pro Go2', 'USB MIDI Device']) {
    assert.equal(detectControllerPreset({ name, manufacturer: '' }), undefined)
  }
  assert.equal(detectControllerPreset({ name: 'USB MIDI 1', manufacturer: 'Numark Mixstream Pro Go' }), mixstream)
})

test('FLX4 binds the documented deck channels, pad channels, and complete fourteen-bit pairs', () => {
  for (const [index, deck] of ['A', 'B'].entries()) {
    const channel = index + 1
    assert.deepEqual(control(flx4, `${deck}:play`), { kind: 'note', channel, number: 0x0b })
    assert.deepEqual(control(flx4, `${deck}:sync`), { kind: 'note', channel, number: 0x58 })
    for (const [action, number, lsb] of [
      ['tempo', 0x00, 0x20], ['gain', 0x04, 0x24], ['high', 0x07, 0x27],
      ['mid', 0x0b, 0x2b], ['low', 0x0f, 0x2f], ['volume', 0x13, 0x33],
    ]) {
      assert.deepEqual(control(flx4, `${deck}:${action}`), { kind: 'cc', channel, number, lsb })
    }
    assert.deepEqual(control(flx4, `${deck}:filter`), { kind: 'cc', channel: 7, number: 0x17 + index, lsb: 0x37 + index })
    assert.deepEqual(control(flx4, `${deck}:hot-8`), { kind: 'note', channel: index === 0 ? 8 : 10, number: 7 })
  }
  assert.deepEqual(control(flx4, 'M:crossfader'), { kind: 'cc', channel: 7, number: 0x1f, lsb: 0x3f })
  assert.deepEqual(control(flx4, 'M:master'), { kind: 'cc', channel: 7, number: 0x08, lsb: 0x28 })
})

test('Mixstream routes its four physical pads by mode and shift, with nonstandard pitch pairs', () => {
  for (const [index, deck] of ['A', 'B'].entries()) {
    const channel = index + 3
    assert.deepEqual(control(mixstream, `${deck}:play`), { kind: 'note', channel, number: 0x0a })
    assert.deepEqual(control(mixstream, `${deck}:sync`), { kind: 'note', channel, number: 0x08 })
    assert.deepEqual(control(mixstream, `${deck}:tempo`), { kind: 'cc', channel, number: 0x1f, lsb: 0x4b })
    for (const [action, number] of [
      ['gain', 0x03], ['high', 0x04], ['mid', 0x06], ['low', 0x08], ['filter', 0x0b], ['volume', 0x0e],
    ]) {
      assert.deepEqual(control(mixstream, `${deck}:${action}`), { kind: 'cc', channel: index + 1, number })
    }
    assert.deepEqual(mixstream.shifts[deck], { kind: 'note', channel, number: 0x1c })
    for (let pad = 0; pad < 4; pad++) {
      const first = mixstream.bindings.find(binding => binding.actionId === `${deck}:hot-${pad + 1}`)
      const second = mixstream.bindings.find(binding => binding.actionId === `${deck}:hot-${pad + 5}`)
      assert.deepEqual(first.control, { kind: 'note', channel, number: 0x0f + pad })
      assert.deepEqual(second.control, first.control)
      assert.deepEqual(first.when, { deck, mode: 'hotcue', shift: false })
      assert.deepEqual(second.when, { deck, mode: 'hotcue', shift: true })
      assert.deepEqual(control(mixstream, `${deck}:loop-size-${[4, 8, 16, 32][pad]}`), first.control)
      assert.deepEqual(control(mixstream, `${deck}:loop-saved-${pad + 1}`), first.control)
    }
    assert.deepEqual(mixstream.modes.filter(mode => mode.deck === deck).map(mode => [mode.control.number, mode.mode]), [
      [0x0b, 'hotcue'], [0x0c, 'savedloop'], [0x0d, 'roll'], [0x0e, 'autoloop'],
    ])
  }
  assert.deepEqual(control(mixstream, 'M:crossfader'), { kind: 'cc', channel: 16, number: 0x0e })
  assert.deepEqual(control(mixstream, 'M:master'), { kind: 'cc', channel: 16, number: 0x0f })
})

test('presets use known actions and contain no conflicting control or target within a condition', () => {
  const targets = new Map(studioMidiTargets.map(target => [target.id, target]))
  for (const preset of controllerPresets) {
    const controls = new Set()
    const actions = new Set()
    for (const binding of preset.bindings) {
      const target = targets.get(binding.actionId)
      assert.ok(target, `${preset.id} action ${binding.actionId} exists`)
      assert.equal(target.kind === 'button' ? 'note' : 'cc', binding.control.kind)
      assert.ok(binding.control.channel >= 1 && binding.control.channel <= 16)
      assert.ok(binding.control.number >= 0 && binding.control.number < 120)
      const condition = JSON.stringify(binding.when ?? null)
      const key = `${JSON.stringify(binding.control)}:${condition}`
      const action = `${binding.actionId}:${condition}`
      assert.equal(controls.has(key), false, `${preset.id} control ${key} is unique`)
      assert.equal(actions.has(action), false, `${preset.id} action ${action} is unique`)
      controls.add(key)
      actions.add(action)
    }
  }
})
