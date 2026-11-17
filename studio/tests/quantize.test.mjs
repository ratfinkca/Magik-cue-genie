import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/quantize.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { quantizeTime } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const beats = Array.from({ length: 8 }, (_, index) => 0.125 + index * 0.5)

test('leaves times untouched outside the observed grid or when snapping is off', () => {
  assert.equal(quantizeTime(1.3, beats, 'off'), 1.3)
  assert.equal(quantizeTime(1.3, [], 'beat'), 1.3)
  assert.equal(quantizeTime(0.1, beats, 'quarter'), 0.1)
  assert.equal(quantizeTime(3.63, beats, 'beat'), 3.63)
})

test('snaps to whole beats and fractions relative to the observed beat phase', () => {
  assert.equal(quantizeTime(1.29, beats, 'beat'), 1.125)
  assert.equal(quantizeTime(1.33, beats, 'half'), 1.375)
  assert.equal(quantizeTime(1.28, beats, 'quarter'), 1.25)
  assert.equal(quantizeTime(1.32, beats, 'eighth'), 1.3125)
  assert.equal(quantizeTime(0.125, beats, 'eighth'), 0.125)
  assert.equal(quantizeTime(3.625, beats, 'half'), 3.625)
})

test('snaps within a supported interval without assuming uniform tempo', () => {
  const drifting = [0.12, 0.63, 1.125, 1.612, 2.108, 2.58]
  const expected = (drifting[2] + drifting[3]) / 2
  assert.equal(quantizeTime(1.36, drifting, 'half'), expected)
})

test('leaves grid gaps alone while allowing a nearby observed beat', () => {
  const gap = beats.filter(time => time !== 1.625 && time !== 2.125)
  assert.equal(quantizeTime(1.79, gap, 'eighth'), 1.79)
  assert.equal(quantizeTime(1.79, gap, 'beat'), 1.79)
  assert.equal(quantizeTime(2.59, gap, 'quarter'), 2.625)
  const oneMissing = beats.filter(time => time !== 1.625)
  assert.equal(quantizeTime(1.67, oneMissing, 'half'), 1.67)
})

test('synthesized intervals at the supported tempo boundaries still snap', () => {
  const fast = Array.from({ length: 12 }, (_, index) => .02 + index * .15)
  const slow = Array.from({ length: 12 }, (_, index) => .025 + index * 1.5)
  for (const grid of [fast, slow]) {
    for (let i = 0; i < grid.length - 1; i++) {
      const middle = (grid[i] + grid[i + 1]) / 2
      assert.ok(Math.abs(quantizeTime(middle + .002, grid, 'half') - middle) < 1e-9)
    }
  }
})
