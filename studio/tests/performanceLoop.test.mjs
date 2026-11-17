import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const options = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64")
const quantize = await readFile(new URL("../src/quantize.ts", import.meta.url), "utf8")
const loop = await readFile(new URL("../src/performanceLoop.ts", import.meta.url), "utf8")
const quantizeUrl = moduleUrl(ts.transpileModule(quantize, options).outputText)
const output = ts.transpileModule(loop, options).outputText.replaceAll(/["']\.\/quantize["']/g, JSON.stringify(quantizeUrl))
const { LOOP_FACTORS, captureLoopEdge, clampPerformanceLoopEdge, makeBeatLoop,
  movePerformanceLoop, normalizePerformanceLoop, resizePerformanceLoop } = await import(moduleUrl(output))

test("manual loop edges snap to observed subdivisions and require valid audio boundaries", () => {
  const beats = [0, .5, 1, 1.5, 2, 2.5, 3]
  assert.equal(captureLoopEdge(1.22, beats, "half", 4), 1.25)
  assert.equal(captureLoopEdge(1.22, beats, "off", 4), 1.22)
  assert.equal(captureLoopEdge(-.1, beats, "off", 4), null)
  assert.equal(normalizePerformanceLoop(.5, .51, 4), null)
  assert.equal(normalizePerformanceLoop(.5, 4.01, 4), null)
  assert.deepEqual(normalizePerformanceLoop(.5, 4, 4), { start: .5, end: 4 })
})

test("beat loop presets count observed intervals and preserve beat phase without quantize", () => {
  const beats = [.2, .7, 1.25, 1.82, 2.41, 3.01, 3.62, 4.14, 4.7, 5.25, 5.8]
  const onBeat = makeBeatLoop(.692, 4, beats, 140, "beat", 6)
  assert.equal(onBeat?.timing, "observed")
  assert.deepEqual(onBeat?.range, { start: .7, end: 3.01 })
  const offBeat = makeBeatLoop(.45, 2, beats, null, "off", 6)
  assert.equal(offBeat?.timing, "observed")
  assert.equal(offBeat?.range.start, .45)
  assert.ok(Math.abs(offBeat.range.end - 1.535) < .000001)
})

test("an observed gap uses tempo for loop length while keeping the requested start", () => {
  const sparse = [0, .5, 1, 2, 2.5, 3, 3.5]
  assert.deepEqual(makeBeatLoop(1, 2, sparse, 120, "beat", 4), { range: { start: 1, end: 2 }, timing: "tempo" })
  assert.equal(makeBeatLoop(1, 2, sparse, null, "beat", 4), null)
  assert.deepEqual(makeBeatLoop(.51, 2, [], 120, "beat", 4), { range: { start: .51, end: 1.51 }, timing: "tempo" })
  assert.equal(makeBeatLoop(3.9, 1, sparse, 120, "beat", 4), null)
  assert.equal(makeBeatLoop(-.51, 2, [], 120, "beat", 4), null)
})

test("graphical edge trim clamps to audio bounds and never crosses the opposite edge", () => {
  const range = { start: 10, end: 12 }
  assert.deepEqual(clampPerformanceLoopEdge(range, "start", -3, 20), { start: 0, end: 12 })
  assert.deepEqual(clampPerformanceLoopEdge(range, "end", 50, 20), { start: 10, end: 20 })
  const movedIn = clampPerformanceLoopEdge(range, "start", 14, 20)
  assert.equal(movedIn.end, range.end)
  assert.ok(movedIn.end >= movedIn.start + .05)
  assert.ok(Math.abs(movedIn.start - 11.95) < 1e-12)
  assert.deepEqual(clampPerformanceLoopEdge(range, "end", 5, 20), { start: 10, end: 10.05 })
  assert.equal(clampPerformanceLoopEdge(range, "end", NaN, 20), null)
})

test("boundary and whole-loop drags snap on the measured grid, with free adjustment when disabled", () => {
  const beats = Array.from({ length: 41 }, (_, index) => index / 2)
  const original = { start: 2, end: 3.3 }
  assert.deepEqual(clampPerformanceLoopEdge(original, "start", 2.38, 20, beats, "beat"), { start: 2.5, end: 3.3 })
  assert.deepEqual(clampPerformanceLoopEdge(original, "start", 2.38, 20, beats, "off"), { start: 2.38, end: 3.3 })
  assert.equal(clampPerformanceLoopEdge(original, "end", 2.07, 20, beats, "beat"), null)
  assert.deepEqual(movePerformanceLoop(original, 4.29, 20, beats, "beat"), { start: 4.5, end: 5.8 })
  assert.deepEqual(movePerformanceLoop(original, -10, 20), { start: 0, end: original.end - original.start })
  const moved = movePerformanceLoop(original, 30, 20)
  assert.equal(moved.end, 20)
  assert.ok(Math.abs((moved.end - moved.start) - (original.end - original.start)) < 1e-12)
})

test("fractional and 32-beat presets use measured beat intervals", () => {
  const beats = Array.from({ length: 50 }, (_, index) => index / 2)
  assert.deepEqual(makeBeatLoop(1, .25, beats, null, "off", 30), { range: { start: 1, end: 1.125 }, timing: "observed" })
  assert.deepEqual(makeBeatLoop(1.125, .5, beats, null, "off", 30), { range: { start: 1.125, end: 1.375 }, timing: "observed" })
  assert.deepEqual(makeBeatLoop(1, 32, beats, null, "off", 30), { range: { start: 1, end: 17 }, timing: "observed" })
  assert.equal(makeBeatLoop(1, .25, [], 400, "off", 30), null)
})

test("the loop bank starts at an eighth beat and resets to the measured beat at In", () => {
  assert.deepEqual(LOOP_FACTORS, [.125, .25, .5, 1, 2, 4, 8])
  const measured = [0, .5, 1, 1.56, 2.06, 2.55, 3.1]
  const eighth = makeBeatLoop(1, .125, measured, 120, "off", 8)
  assert.deepEqual(eighth, { range: { start: 1, end: 1.07 }, timing: "observed" })
  assert.deepEqual(makeBeatLoop(1, 1, measured, 120, "off", 8),
    { range: { start: 1, end: 1.56 }, timing: "observed" })
})

test("loop factors repeat on the actual current length and keep its In point", () => {
  const custom = { start: 7.125, end: 7.875 }
  const doubled = resizePerformanceLoop(custom, 2, 60)
  assert.deepEqual(doubled, { start: 7.125, end: 8.625 })
  const doubledAgain = resizePerformanceLoop(doubled, 2, 60)
  assert.deepEqual(doubledAgain, { start: 7.125, end: 10.125 })
  assert.deepEqual(resizePerformanceLoop(doubledAgain, .25, 60), custom)
  assert.deepEqual(resizePerformanceLoop(custom, .125, 60), { start: 7.125, end: 7.21875 })
  assert.equal(resizePerformanceLoop({ start: 7, end: 7.25 }, .125, 60), null)
  assert.equal(resizePerformanceLoop({ start: 58, end: 59 }, 8, 60), null)
})

test("quantized adjustments stay continuous where the measured beatgrid has a gap", () => {
  const beats = [0, .5, 1, 3, 3.5, 4]
  const original = { start: .5, end: 4 }
  assert.deepEqual(clampPerformanceLoopEdge(original, "start", 2.15, 9, beats, "quarter"), { start: 2.15, end: 4 })
  assert.deepEqual(movePerformanceLoop(original, 2.15, 9, beats, "quarter"), { start: 2.15, end: 5.65 })
})
