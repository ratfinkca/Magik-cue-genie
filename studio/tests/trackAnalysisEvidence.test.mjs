import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

function moduleUrl(input) {
  const code = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
}
const source = name => readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')
const [evidence, tags, grids] = await Promise.all(['trackAnalysisEvidence', 'trackMetadata', 'beatGrid'].map(source))
const { readDeckTempo, readDeckKey } = await import(moduleUrl(evidence.replace('"./trackMetadata"', JSON.stringify(moduleUrl(tags)))))
const { readBeatTimes, readModelBeatTimes, readManualBeatGrid, manualBeatTicks } = await import(moduleUrl(grids))

test('a valid file BPM takes precedence over a tempo-only signal result', () => {
  const analysis = { estimated_bpm: 127.7, estimated_bpm_source: 'studio_onset_autocorrelation',
    studio_tempo: { status: 'tempo_only', bpm: 127.7 } }
  assert.deepEqual(readDeckTempo(analysis, 128, false), { bpm: 128, source: 'file_tag' })
  assert.deepEqual(readDeckTempo(analysis, null, false), { bpm: 127.7, source: 'estimate' })
  assert.deepEqual(readDeckTempo({ estimated_bpm: 128, estimated_bpm_source: 'file_tag' }, null, false),
    { bpm: 128, source: 'file_tag' })
})

test('observed grid tempo stays tied to its own beat positions', () => {
  assert.deepEqual(readDeckTempo({ estimated_bpm: 127.3 }, 128, true), { bpm: 127.3, source: 'beat_grid' })
  assert.deepEqual(readDeckTempo({ estimated_bpm: NaN }, 900, false), { bpm: null, source: null })
})

test('key prefers a file tag and restores the saved source without inventing a new tag', () => {
  const fileKey = { pitchClass: 7, mode: 'major', confidence: 0, method: 'file-tag', analyzedWindows: 0 }
  const signalKey = { pitchClass: 7, mode: 'minor', confidence: .52, method: 'sampled-chroma-v1', analyzedWindows: 5 }
  assert.equal(readDeckKey(null, fileKey, signalKey), fileKey)
  assert.equal(readDeckKey(null, null, signalKey), signalKey)
  assert.equal(readDeckKey({ estimated_key: 'G major', studio_key_source: 'file_tag' }, null, null)?.method, 'file-tag')
  assert.equal(readDeckKey({ estimated_key: 'G major', studio_key_source: 'audio' }, null, null)?.method, 'saved-estimate')
})

test('Beat This predictions can be read for display but cannot be read as measured timing', () => {
  const prediction = { status: 'predicted', source: 'beat_this_small0', beat_times_seconds: [.05, .55, 1.05] }
  assert.deepEqual(readModelBeatTimes(prediction, 2), [.05, .55, 1.05])
  assert.deepEqual(readBeatTimes(prediction, 2), [])
  assert.deepEqual(readModelBeatTimes({ ...prediction, status: 'estimated' }, 2), [])
  assert.deepEqual(readModelBeatTimes({ ...prediction, beat_times_seconds: [.05, .04] }, 2), [])
})

test('a manual downbeat anchors a steady grid on both sides of the playhead without becoming an observation', () => {
  const manual = { version: 1, bpm: 120, anchor_seconds: 2.125 }
  assert.deepEqual(readManualBeatGrid(manual, 4), manual)
  const ticks = manualBeatTicks(manual, 3, -.5)
  assert.deepEqual(ticks.find(tick => tick.index === 0), { time: 2.125, index: 0, estimated: false })
  assert.deepEqual(ticks[0], { time: -.375, index: -5, estimated: true })
  assert.deepEqual(ticks.at(-1), { time: 2.625, index: 1, estimated: false })
  assert.deepEqual(readBeatTimes(manual, 4), [])
  for (const bad of [{ ...manual, bpm: Infinity }, { ...manual, anchor_seconds: 4 },
    { ...manual, anchor_seconds: -.01 }, { ...manual, version: 9 }]) assert.equal(readManualBeatGrid(bad, 4), null)
})
