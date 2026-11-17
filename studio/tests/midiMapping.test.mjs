import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/midiMapping.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { createMidiSoftTakeover, decodeMidiMessage, isMidiControl, midiAbsoluteValue,
  midiButtonPressed, midiControlKey } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64"))

test("MIDI Note On, zero velocity and explicit Note Off normalize to one pad identity", () => {
  const press = decodeMidiMessage(Uint8Array.of(0x9f, 73, 87))
  const zeroVelocity = decodeMidiMessage(Uint8Array.of(0x9f, 73, 0))
  const noteOff = decodeMidiMessage(Uint8Array.of(0x8f, 73, 64))
  assert.deepEqual(press, { kind: "note", channel: 16, number: 73, value: 87, pressed: true })
  assert.equal(midiButtonPressed(press), true)
  assert.equal(midiButtonPressed(zeroVelocity), false)
  assert.equal(midiButtonPressed(noteOff), false)
  assert.equal(noteOff.value, 64)
  assert.equal(midiControlKey(press), midiControlKey(zeroVelocity))
  assert.equal(midiControlKey(press), midiControlKey(noteOff))
  assert.equal(midiAbsoluteValue(press), null)
})

test("MIDI CC supports channel isolation, absolute endpoints and binary switch threshold", () => {
  const cc = (status, value) => decodeMidiMessage([status, 7, value])
  const minimum = cc(0xb0, 0)
  const maximum = cc(0xb0, 127)
  assert.deepEqual(maximum, { kind: "cc", channel: 1, number: 7, value: 127 })
  assert.equal(midiAbsoluteValue(minimum), 0)
  assert.equal(midiAbsoluteValue(maximum), 1)
  assert.equal(midiAbsoluteValue(cc(0xb0, 64)), 64 / 127)
  assert.equal(midiButtonPressed(cc(0xb0, 63)), false)
  assert.equal(midiButtonPressed(cc(0xb0, 64)), true)
  assert.notEqual(midiControlKey(maximum), midiControlKey(cc(0xb1, 127)))
  assert.notEqual(midiControlKey(maximum), midiControlKey(decodeMidiMessage([0x90, 7, 127])))
})

test("MIDI learn rejects malformed events, unsupported statuses and channel-mode controls", () => {
  for (const bytes of [
    [0x90, 2], [0x80, 2, 0, 4], [0xb0, 128, 0], [0xb0, 4, 0.5], [0x190, 7, 127], [0x7f, 4, 5],
    [0xf8], [0xf0, 7, 0xf7], [0xe0, 2, 30], [0xa0, 9, 50], [0xb0, 123, 0],
  ]) assert.equal(decodeMidiMessage(bytes), null, JSON.stringify(bytes))
  assert.equal(isMidiControl({ kind: "note", channel: 16, number: 127 }), true)
  assert.equal(isMidiControl({ kind: "cc", channel: 1, number: 119 }), true)
  for (const candidate of [
    null, [], 1, { kind: "cc", channel: 0, number: 2 }, { kind: "cc", channel: 16, number: 120 },
    { kind: "note", channel: "1", number: 2 }, { kind: "note", channel: 1, number: 128 },
  ]) assert.equal(isMidiControl(candidate), false)
})

test("pickup waits for the first reach or crossing and latches an independent key", () => {
  const takeover = createMidiSoftTakeover()
  assert.equal(takeover.accept("deckA", .1, .55), false)
  assert.equal(takeover.accept("deckA", .4, .55), false)
  assert.equal(takeover.accept("deckA", .62, .55), true)
  assert.equal(takeover.accept("deckA", .9, .62), true)
  assert.equal(takeover.accept("deckB", .9, .62), false)
  assert.equal(takeover.accept("deckB", .48, .62), true)
  takeover.reset("deckA")
  assert.equal(takeover.accept("deckA", .9, .62), false)
  assert.equal(takeover.accept("deckB", .99, .48), true)
  takeover.reset()
  assert.equal(takeover.accept("deckB", .2, .48), false)
})

test("pickup respects the current target and permits a hardware step at the halfway setting", () => {
  const takeover = createMidiSoftTakeover()
  assert.equal(takeover.accept("midpoint", 64 / 127, .5), true)
  assert.equal(takeover.accept("moving", .1, .5), false)
  assert.equal(takeover.accept("moving", .55, .75), false)
  assert.equal(takeover.accept("moving", Number.NaN, .75), false)
  assert.equal(takeover.accept("moving", .8, .75), true)
})
