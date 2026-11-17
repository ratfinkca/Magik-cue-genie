import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/transitionMixer.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } })
const { getCrossfaderGain, getCrossfaderMarks, getDeckOutputGain, normalizeGainDb, normalizeCrossfaderCustom } =
  await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"))

test("custom crossfade can open smoothly or sharply and marks each full-open point", () => {
  const linear = { cut: 0, softness: 0 }
  const softened = { cut: 0, softness: 100 }
  const sharp = { cut: 100, softness: 0 }
  assert.equal(getCrossfaderGain("B", 50, "custom", linear), .5)
  assert.ok(Math.abs(getCrossfaderGain("B", 50, "custom", softened) - Math.SQRT1_2) < 1e-10)
  const marks = getCrossfaderMarks("custom", sharp)
  assert.deepEqual(marks, [0, 3, 50, 97, 100])
  for (const custom of [linear, softened, sharp]) {
    assert.equal(getCrossfaderGain("A", 0, "custom", custom), 1)
    assert.equal(getCrossfaderGain("A", 100, "custom", custom), 0)
    assert.equal(getCrossfaderGain("B", 0, "custom", custom), 0)
    assert.equal(getCrossfaderGain("B", 100, "custom", custom), 1)
    assert.equal(getCrossfaderGain("A", 75, "custom", custom), getCrossfaderGain("B", 25, "custom", custom))
  }
  assert.equal(getCrossfaderGain("B", marks[1], "custom", sharp), 1)
  assert.equal(getCrossfaderGain("A", marks[3], "custom", sharp), 1)
})

test("stored mixer values are bounded, including the expanded channel gain", () => {
  assert.deepEqual(normalizeCrossfaderCustom({ cut: -1, softness: Infinity }), { cut: 0, softness: 50 })
  assert.equal(normalizeGainDb(-80), -60)
  assert.equal(normalizeGainDb(25), 18)
  assert.ok(getDeckOutputGain("A", 0, "linear", 18) > 7.9)
})
