import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/cuePreparation.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { cueIdentity, identifyCues, restoreCueEdits } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

function mark(id, label, seconds) {
  return { label, time_seconds: seconds, confidence: 1, reason: 'Synthetic cue', metadata: { studio_id: id } }
}

test('legacy cue identities are deterministic across decks and preserve existing lead-in targets', () => {
  const original = [mark('first', 'Cue', 0), { label: 'Lead-in', time_seconds: -2, confidence: 1, reason: 'Synthetic',
    metadata: { lead_in: { target_id: 'first' } } }]
  const loadedA = identifyCues(original)
  const loadedB = identifyCues(structuredClone(original))
  assert.deepEqual(loadedA, loadedB)
  assert.equal(cueIdentity(loadedA[0]), 'first')
  assert.equal(loadedA[1].metadata.lead_in.target_id, 'first')
  assert.notEqual(cueIdentity(loadedA[1]), cueIdentity(loadedA[0]))
})

test('one deck can undo a cue edit without rolling back another deck’s cue and time changes', () => {
  const before = mark('first', 'First', 5)
  const after = { ...before, label: 'My title' }
  const remote = { ...after, time_seconds: 7 }
  const newer = mark('second', 'Other deck', 15)
  assert.deepEqual(restoreCueEdits([remote, newer], [before], [after]), [
    { ...before, time_seconds: 7 }, newer,
  ])
  const lastTitle = { ...remote, label: 'Last title' }
  assert.deepEqual(restoreCueEdits([lastTitle, newer], [before], [after]), [lastTitle, newer])
})

test('undo rejoins a linked lead-in before its target without deleting cues the other deck added', () => {
  const a = mark('intro', 'Intro', 0)
  const b = mark('drop', 'Drop', 12)
  const lead = { ...mark('lead', 'Lead-in', 8), metadata: { studio_id: 'lead', lead_in: { target_id: 'drop' } } }
  const remote = mark('tail', 'Tail', 38)
  assert.deepEqual(restoreCueEdits([a, remote], [a, lead, b], [a]), [a, remote, lead, b])
  assert.deepEqual(restoreCueEdits([a, lead, b, remote], [a, b], [a, lead, b]), [a, b, remote])
  assert.deepEqual(restoreCueEdits([a, remote, b, lead], [a, lead, b], [a, b, lead]), [a, remote, lead, b])
})

test('undoing a loop move restores its duration and keeps the other deck’s arm toggle', () => {
  const before = { ...mark('loop', 'Loop', 24), metadata: { studio_id: 'loop', loop: { end_seconds: 28, active: false } } }
  const after = { ...before, time_seconds: 28, metadata: { ...before.metadata, loop: { end_seconds: 32, active: false } } }
  const remote = { ...after, metadata: { ...after.metadata, loop: { end_seconds: 32, active: true } } }
  assert.deepEqual(restoreCueEdits([remote], [before], [after]), [
    { ...before, metadata: { ...before.metadata, loop: { end_seconds: 28, active: true } } },
  ])
})
