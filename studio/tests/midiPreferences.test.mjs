import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
async function compile(module) {
  const source = await readFile(new URL(`../src/${module}.ts`, import.meta.url), 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

const { validateMidiPreferences, putMidiBinding, removeMidiBinding, MAX_MIDI_BINDINGS } = await import(
  moduleUrl((await compile('midiPreferences')).replace('"./midiMapping"', JSON.stringify(moduleUrl(await compile('midiMapping'))))))

const cc = { kind: 'cc', channel: 1, number: 7 }
const note = { kind: 'note', channel: 1, number: 9 }
const binding = (inputId, actionId, control = cc) => ({ inputId, actionId, control })

test('validated preferences keep legal mappings and discard malformed or unsupported input', () => {
  const source = { version: 1, bindings: [
    binding('port-a', 'gain-a'), binding('port-b', 'gain-a'), binding('port-b', 'bad', { ...cc, channel: 0 }),
    binding('port-e', 'bad', { ...cc, number: 121 }), binding('port-b', '', note),
    { inputId: 'port-c', actionId: 'cue-b', control: { ...note, value: 99 }, ignored: true }, null,
  ] }
  assert.deepEqual(validateMidiPreferences(source), { version: 1, bindings: [
    binding('port-a', 'gain-a'), binding('port-b', 'gain-a'), binding('port-c', 'cue-b', note),
  ] })
  assert.equal(validateMidiPreferences({ version: 2, bindings: [] }), null)
})

test('a port binds each physical control and target once, with reassignment scoped to the port', () => {
  const source = [binding('one', 'gain-a'), binding('two', 'gain-a'), binding('one', 'cue-a', note)]
  assert.deepEqual(putMidiBinding(source, binding('one', 'gain-b')), [
    binding('two', 'gain-a'), binding('one', 'cue-a', note), binding('one', 'gain-b'),
  ])
  assert.deepEqual(putMidiBinding(source, binding('one', 'gain-a', note)), [
    binding('two', 'gain-a'), binding('one', 'gain-a', note),
  ])
  assert.deepEqual(removeMidiBinding(source, 'two', 'gain-a'), [binding('one', 'gain-a'), binding('one', 'cue-a', note)])
  assert.deepEqual(validateMidiPreferences({ version: 1, bindings: [...source, binding('one', 'gain-b')] }).bindings,
    putMidiBinding(source, binding('one', 'gain-b')))
})

test('an overfull profile still permits replacing a mapping without deleting another controller', () => {
  const profile = Array.from({ length: MAX_MIDI_BINDINGS }, (_, index) => binding(`port-${index}`, 'gain-a'))
  assert.equal(putMidiBinding(profile, binding('extra-port', 'cue-a', note)), null)
  const replaced = putMidiBinding(profile, binding('port-0', 'gain-b'))
  assert.equal(replaced.length, MAX_MIDI_BINDINGS)
  assert.deepEqual(replaced.at(-1), binding('port-0', 'gain-b'))
})
