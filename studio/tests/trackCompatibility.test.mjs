import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/trackCompatibility.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { compareTrackCompatibility } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))

const phrase = { start: 16, beats: 32, source: 'measured', regularity: .94 }
const reference = { bpm: 128, genres: ['Drum & Bass'], matchEvidence: { energy: { rating: 7 }, phrasing: { outro: phrase } } }

test('a four-factor comparison describes tempo adjustments and directional phrase overlap', () => {
  const next = { bpm: 64, genres: ['drum and bass'], matchEvidence: { energy: { rating: 6 }, phrasing: { intro: phrase } } }
  const match = compareTrackCompatibility(reference, next)
  assert.equal(match.level, 'close')
  assert.equal(match.compared, 4)
  assert.match(match.detail, /double time/)
  assert.match(match.detail, /32-beat estimated outro\/intro overlap/)
  assert.equal(compareTrackCompatibility(next, reference).compared, 3)
})

test('a bare tempo match is limited, and unrelated tempos, genres, and energy rank lower', () => {
  assert.equal(compareTrackCompatibility(reference, { bpm: 128 }).score, null)
  assert.equal(compareTrackCompatibility(reference, { bpm: 128 }).level, 'limited')
  const next = { bpm: 150, genres: ['Ambient'], matchEvidence: { energy: { rating: 1 } } }
  assert.equal(compareTrackCompatibility(reference, next).level, 'distant')
  assert.match(compareTrackCompatibility(reference, next).detail, /3 of 4 factors/)
})
