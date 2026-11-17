import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = name => readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
function moduleUrl(input) {
  const js = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  return 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
}
const [edit, cues, loops, trackTime, prep] = await Promise.all(
  ['cueEdit', 'cues', 'loops', 'trackTime', 'cuePreparation'].map(source),
)
const timeUrl = moduleUrl(trackTime)
const cuesUrl = moduleUrl(cues.replace('"./trackTime"', JSON.stringify(timeUrl)))
const { applyCueEdit } = await import(moduleUrl(edit
  .replace('"./cues"', JSON.stringify(cuesUrl))
  .replace('"./loops"', JSON.stringify(moduleUrl(loops)))
  .replace('"./trackTime"', JSON.stringify(timeUrl))))
const { cueColor, readSidecar } = await import(cuesUrl)
const { restoreCueEdits } = await import(moduleUrl(prep))

function loopCue() {
  return {
    label: 'Drum break', time_seconds: 2, confidence: .9, reason: 'Synthetic edit test',
    metadata: { color: '#EE4466', studio_id: 'break', memo: 'electronic',
      loop: { start_seconds: 2, end_seconds: 6, kind: 'manual', active: true, marker: 'kept' } },
  }
}

test('cue colors normalize safe hex and preserve other sidecar metadata', () => {
  const first = { ...loopCue(), metadata: { ...loopCue().metadata, color: '#AbC' } }
  const second = { ...first, metadata: { ...first.metadata, color: 'url(https://example.test/)' } }
  const sidecar = readSidecar(JSON.stringify({ source_file: 'fixture.wav', schema_version: 1, analysis: {},
    cues: [first, second], warnings: [] }), 'fixture.wav', 10)
  assert.equal(cueColor(sidecar.cues[0]), '#aabbcc')
  assert.equal(sidecar.cues[0].metadata.color, '#aabbcc')
  assert.equal(sidecar.cues[0].metadata.memo, 'electronic')
  assert.deepEqual(sidecar.cues[0].metadata.loop, first.metadata.loop)
  assert.equal(cueColor(sidecar.cues[1]), undefined)
})

test('a single edit can move both saved loop endpoints and set its color while retaining cue identity', () => {
  const before = loopCue()
  const after = applyCueEdit(before, { time_seconds: 3.00125, loopEndSeconds: 8.3202, color: '#23AB80' }, 10)
  assert.equal(after.time_seconds, 3.00125)
  assert.deepEqual(after.metadata, { ...before.metadata, color: '#23ab80',
    loop: { ...before.metadata.loop, start_seconds: 3.00125, end_seconds: 8.3202 } })
  assert.deepEqual(restoreCueEdits([after], [before], [after]), [before])
})

test('changing one endpoint leaves the other fixed and rejects invalid or too-short endpoints atomically', () => {
  const before = loopCue()
  const start = applyCueEdit(before, { time_seconds: 3.1 }, 10)
  assert.equal(start.metadata.loop.end_seconds, 6)
  const end = applyCueEdit(before, { loopEndSeconds: 7.2 }, 10)
  assert.equal(end.time_seconds, 2)
  for (const patch of [{ time_seconds: -1 }, { time_seconds: 6 }, { loopEndSeconds: 11 },
    { loopEndSeconds: 2.025 }, { loopEndSeconds: NaN }]) {
    assert.equal(typeof applyCueEdit(before, patch, 10), 'string')
  }
  assert.equal(before.metadata.loop.end_seconds, 6)
})

test('deck default clears custom color without changing a cue or its saved loop', () => {
  const before = loopCue()
  const after = applyCueEdit(before, { color: null }, 10)
  assert.equal(cueColor(after), undefined)
  assert.equal(after.metadata.studio_id, before.metadata.studio_id)
  assert.equal(after.metadata.loop, before.metadata.loop)
  const plain = { ...after, time_seconds: 0, metadata: { studio_id: 'pre-roll' } }
  assert.equal(applyCueEdit(plain, { time_seconds: -3.2 }, 10).time_seconds, -3.2)
})
