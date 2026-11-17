import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/waveformTimeline.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { estimateBeatGrid, timelineGridTicks } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const observedGridTicks = (times, ...options) => timelineGridTicks(
  times.map((time, index) => ({ time, index, estimated: false })), ...options,
).map(({ estimated, ...tick }) => tick)

const beats = [.25, .75, 1.22, 1.73, 2.2, 2.71, 4.25, 4.77, 5.26, 5.76]

test('beat mode uses the observed times and preserves beat numbers at a zoomed-in origin', () => {
  assert.deepEqual(observedGridTicks(beats, .8, 2.3, 240, null), [
    { time: 1.22, number: 3, bar: null }, { time: 1.73, number: 4, bar: null }, { time: 2.2, number: 5, bar: null },
  ])
  assert.deepEqual(observedGridTicks(beats, 3, 4, 240, null), [])
})

test('bar accents count from the first observed beat at the selected meter', () => {
  const ticks = observedGridTicks(beats, 1, 5.8, 240, 3).filter(tick => tick.bar !== null)
  assert.deepEqual(ticks, [
    { time: 1.73, number: 4, bar: 2 }, { time: 4.25, number: 7, bar: 3 }, { time: 5.76, number: 10, bar: 4 },
  ])
})

test('dense musical grids retain counted accents in Bars and avoid overpainting in Beats', () => {
  assert.deepEqual(observedGridTicks(beats, 0, 6, 30, 4), [
    { time: .25, number: 1, bar: 1 }, { time: 2.2, number: 5, bar: 2 }, { time: 5.26, number: 9, bar: 3 },
  ])
  assert.deepEqual(observedGridTicks(beats, 0, 6, 30, null), [])
})

test('Bars can draw alone or accent the same observations drawn by Beats', () => {
  const barsOnly = observedGridTicks(beats, 0, 6, 240, 4, false)
  assert.deepEqual(barsOnly.map(tick => tick.time), [.25, 2.2, 5.26])
  const both = observedGridTicks(beats, 0, 6, 240, 4, true)
  assert.deepEqual(both.map(tick => tick.time), beats)
  assert.deepEqual(both.filter(tick => tick.bar !== null), barsOnly)
  assert.deepEqual(observedGridTicks(beats, 0, 6, 240, null, false), [])
})

test('fills only tempo-consistent gaps and preserves analyzed timestamps', () => {
  const observations = [.25, .75, 1.25, 2.77, 3.25, 3.75, 8.50, 9, 9.5]
  const grid = estimateBeatGrid(observations, 120, 0)
  assert.deepEqual(grid.filter(beat => !beat.estimated).map(beat => beat.time), observations)
  assert.deepEqual(grid.filter(beat => beat.estimated).map(beat => Number(beat.time.toFixed(6))), [1.756667, 2.263333])
  const bars = timelineGridTicks(grid, 0, 4, 400, 4, false)
  assert.deepEqual(bars.map(tick => [tick.bar, tick.number, tick.estimated]), [[1, 1, false], [2, 5, true]])
})

test('extends the first locally supported pulse into signed pre-roll', () => {
  const observations = [.15, .65, 1.15, 1.65]
  const grid = estimateBeatGrid(observations, null, -1.5)
  assert.deepEqual(grid.slice(0, 3).map(beat => [Number(beat.time.toFixed(2)), beat.index, beat.estimated]),
    [[-1.35, -3, true], [-.85, -2, true], [-.35, -1, true]])
  const fromBpm = estimateBeatGrid([], 120, -.9)
  assert.deepEqual(fromBpm, [{ time: -.5, index: -1, estimated: true }])
  assert.deepEqual(estimateBeatGrid([], null, -1.5), [])
  assert.deepEqual(estimateBeatGrid([13, 13.5, 14], 120, -2).filter(beat => beat.time < 0).map(beat => beat.time),
    [-2, -1.5, -1, -.5])
})

test('projects through a multi-bar break when the endpoint matches local tempo and phase', () => {
  const grid = estimateBeatGrid([.25, .75, 1.25, 17.25, 17.75, 18.25], 120, 0)
  assert.equal(grid.filter(beat => beat.estimated).length, 31)
  assert.deepEqual(grid.find(beat => beat.time === 17.25), { time: 17.25, index: 34, estimated: false })
  assert.equal(estimateBeatGrid([.25, .75, 500.75, 501.25], 120, 0).some(beat => beat.estimated), false)
})
