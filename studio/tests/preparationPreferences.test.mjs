import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const dataModule = js => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
const modules = new Map()
async function compiled(name) {
  if (modules.has(name)) return modules.get(name)
  const file = name === 'EqKnob' ? name + '.tsx' : name + '.ts'
  const input = await readFile(new URL('../src/' + file, import.meta.url), 'utf8')
  let js = ts.transpileModule(input, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  for (const [specifier, dependency] of Array.from(js.matchAll(/"\.\/([A-Za-z]+)"/g), match => [match[0], match[1]])) {
    js = js.replace(specifier, JSON.stringify(await compiled(dependency)))
  }
  if (name === 'EqKnob') {
    js = js.replace('"react"', JSON.stringify(dataModule('export const useRef = current => ({ current });')))
      .replace('"react/jsx-runtime"', JSON.stringify(dataModule('export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;')))
  }
  const result = dataModule(js)
  modules.set(name, result)
  return result
}

const { displayCueColor, parseStudioPreferences } = await import(await compiled('studioPreferences'))
const { mergeTrackAnalysis } = await import(await compiled('analysisPreparation'))
const { default: EqKnob } = await import(await compiled('EqKnob'))

const cue = (label, time_seconds, confidence = .8, metadata) => ({ label, time_seconds, confidence, reason: 'Synthetic test', metadata })
const sidecar = (cues, analysis = { studio_cues: { status: 'ready' } }) => ({
  schema_version: 1, source_file: 'fixture.wav', cues, analysis, warnings: [],
})

test('individual cue color wins over the validated name preference', () => {
  const { cueColors, analysis } = parseStudioPreferences({ cueColors: { 'Mix in': '#Fab', 'Mix out': 'invalid' },
    analysis: { minimumConfidence: .4, vocalLoops: false, emergencyLoops: 'suggest' } })
  assert.deepEqual(cueColors, { 'Mix in': '#ffaabb' })
  assert.deepEqual(analysis, { minimumConfidence: 0, vocalLoops: false, emergencyLoops: 'suggest' })
  assert.equal(displayCueColor(cue(' mix IN ', 0), cueColors), '#ffaabb')
  assert.equal(displayCueColor(cue('Mix in', 0, .8, { color: '#456' }), cueColors), '#445566')
  assert.equal(displayCueColor(cue('Mix out', 8), cueColors), undefined)
})

test('analysis controls filter new suggestions while preserving user cue edits and reliable evidence', () => {
  const oldCue = cue('Edited mix in', 2.2, .3, { studio_suggestion_key: 'Mix in:2200', studio_suggestion_edited: true })
  const oldGrid = { status: 'estimated', beat_times_seconds: [0, .5, 1, 1.5] }
  const previous = sidecar([oldCue], { estimated_bpm: 120, studio_beatgrid: oldGrid, estimated_key: 'A minor' })
  const result = sidecar([cue('Energy rises', 3, .45), cue('Mix out', 8, .71),
    cue('Vocal loop', 6, .8, { loop: { end_seconds: 7, active: true, kind: 'vocal' } })])
  const { sidecar: merged } = mergeTrackAnalysis(previous, result, 10, {
    minimumConfidence: .6, vocalLoops: false, emergencyLoops: 'off',
  })
  assert.deepEqual(merged.cues.map(candidate => candidate.label), ['Edited mix in', 'Mix out'])
  assert.equal(merged.cues[0].time_seconds, 2.2)
  assert.equal(merged.analysis.studio_beatgrid, oldGrid)
  assert.equal(merged.analysis.estimated_key, 'A minor')
  assert.equal(merged.analysis.estimated_bpm, 120)
})

test('reanalysis preserves the manual grid and requires acoustic beats for emergency loops', () => {
  const manual = { version: 1, bpm: 120, anchor_seconds: .02 }
  const model = { status: 'predicted', source: 'beat_this_small0', beat_times_seconds: [27.02, 27.52, 28.02] }
  const importedTempo = [{ timeSeconds: .02, bpm: 120, meter: '4/4', beat: 1 }, { timeSeconds: 10.02, bpm: 121, meter: '4/4', beat: 1 }]
  const previous = sidecar([], { studio_manual_grid: manual, studio_model_grid: model, studio_rekordbox_tempo: importedTempo })
  const emergency = cue('Emergency loop', 27.02, .9, { loop: { end_seconds: 28.02, active: true, kind: 'emergency' } })
  const { sidecar: merged } = mergeTrackAnalysis(previous, sidecar([emergency]), 30, {
    minimumConfidence: 0, vocalLoops: true, emergencyLoops: 'arm',
  })
  assert.deepEqual(merged.analysis.studio_manual_grid, manual)
  assert.deepEqual(merged.analysis.studio_model_grid, model)
  assert.deepEqual(merged.analysis.studio_rekordbox_tempo, importedTempo)
  assert.equal(merged.cues[0].metadata.loop.active, false)
})

test('each tap-controlled knob owns its own pointer and a drag cannot reflect on release', () => {
  const changes = [[], [], []]
  const knobs = [0, 20, 70].map((value, index) => EqKnob({ label: 'Stem', name: 'Stem ' + index, value,
    min: 0, max: 100, scale: 'linear', disabled: false, reflectOnTap: true, change: next => changes[index].push(next),
  }).props.children[1].props)
  const capture = { focus() {}, setPointerCapture() {} }
  const pointer = (pointerId, clientX = 20, clientY = 40) => ({ pointerId, clientX, clientY,
    currentTarget: capture, button: 0, isPrimary: pointerId === 11 })
  knobs.forEach((knob, index) => knob.onPointerDown(pointer(11 + index)))
  knobs[0].onPointerUp(pointer(13))
  knobs[1].onPointerMove(pointer(12, 21, 39))
  knobs[2].onPointerMove(pointer(13, 20, 10))
  knobs.forEach((knob, index) => knob.onPointerUp(pointer(11 + index, 20, index === 2 ? 10 : 40)))
  assert.deepEqual(changes, [[100], [80], [97]])
  knobs[2].onPointerDown(pointer(22))
  knobs[2].onPointerCancel(pointer(22))
  knobs[2].onPointerUp(pointer(22))
  assert.deepEqual(changes[2], [97])
})
