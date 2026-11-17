import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

async function compile(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
}
const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64")
const commands = moduleUrl(await compile("midiMapping"))
const { createStudioMidiRouter } = await import(moduleUrl((await compile("studioMidiRouting"))
  .replace('"./midiMapping"', JSON.stringify(commands))))
const { midiAxis, studioMidiTargets } = await import(moduleUrl(await compile("studioMidiTargets")))

const note = (inputId, actionId, number = 23) => ({ inputId, actionId, control: { kind: "note", channel: 1, number } })
const cc = (inputId, actionId, number = 11) => ({ inputId, actionId, control: { kind: "cc", channel: 1, number } })

test("MIDI Learn binds only the selected controller and consumes the learned button press", () => {
  const router = createStudioMidiRouter()
  const calls = []
  const route = { targets: studioMidiTargets, bindings: [note("other", "B:play")],
    learning: { inputId: "controller", actionId: "A:play" },
    learned(next) { this.learning = null; this.bindings.push(next); router.updateBindings(this.bindings) },
    press(action) { calls.push(action) }, axis() { return null },
  }
  router.receive("other", [0x90, 23, 127], route)
  router.receive("controller", [0x90, 23, 0], route)
  assert.equal(route.learning.actionId, "A:play")
  router.receive("controller", [0x90, 23, 127], route)
  router.receive("controller", [0x90, 23, 124], route)
  assert.deepEqual(calls, ["B:play"])
  router.receive("controller", [0x80, 23, 25], route)
  router.receive("controller", [0x90, 23, 127], route)
  assert.deepEqual(calls, ["B:play", "A:play"])
  assert.deepEqual(route.bindings[1], note("controller", "A:play"))
})

test("same pad numbers on different devices release independently and unplug cancels holds", () => {
  const router = createStudioMidiRouter()
  const calls = []
  const route = { targets: studioMidiTargets, bindings: [note("left", "A:hot-1"), note("right", "B:hot-1")],
    learning: null, learned() {}, axis() { return null },
    press(action) { calls.push(action); return reason => calls.push(action + " " + reason) },
  }
  router.receive("left", [0x90, 23, 100], route)
  router.receive("right", [0x90, 23, 100], route)
  router.removeInput("left")
  router.receive("right", [0x90, 23, 0], route)
  assert.deepEqual(calls, ["A:hot-1", "B:hot-1", "A:hot-1 cancel", "B:hot-1 release"])
  router.receive("right", [0x90, 23, 100], route)
  router.updateBindings([])
  assert.equal(calls.at(-1), "B:hot-1 cancel")
})

test("remapping a held button cancels it and waits for neutral before accepting the new target", () => {
  const router = createStudioMidiRouter()
  const calls = []
  const route = { targets: studioMidiTargets, bindings: [cc("deck", "A:hot-1")], learning: null, learned() {},
    axis() { return null }, press(action) { calls.push(action); return reason => calls.push(reason) } }
  router.receive("deck", [0xb0, 11, 127], route)
  route.bindings = [cc("deck", "B:hot-1")]
  router.updateBindings(route.bindings)
  router.receive("deck", [0xb0, 11, 126], route)
  assert.deepEqual(calls, ["A:hot-1", "cancel"])
  router.receive("deck", [0xb0, 11, 0], route)
  router.receive("deck", [0xb0, 11, 127], route)
  assert.equal(calls.at(-1), "B:hot-1")
  route.bindings = []
  router.receive("deck", [0xb0, 11, 0], route)
  assert.equal(calls.at(-1), "cancel")
})

test("fader pickup waits for a crossing and rearms when another control changes the software", () => {
  const router = createStudioMidiRouter()
  let position = .5
  const values = []
  const route = { targets: studioMidiTargets, bindings: [cc("deck", "M:crossfader")],
    learning: null, learned() {}, press() {},
    axis() { return { position, set(value) { position = value; values.push(value) } } },
  }
  const move = amount => router.receive("deck", [0xb0, 11, amount], route)
  move(0)
  move(40)
  assert.deepEqual(values, [])
  move(75)
  move(102)
  assert.deepEqual(values, [75 / 127, 102 / 127])
  router.observeAxes(route.axis)
  position = 75 / 127
  router.observeAxes(route.axis)
  move(100)
  assert.equal(position, 75 / 127)
  move(15)
  assert.equal(position, 15 / 127)
})

test("a centered MIDI knob reaches both extremes and the neutral midpoint", () => {
  const values = []
  const axis = midiAxis(0, -36, 6, value => values.push(value), 0)
  assert.equal(axis.position, 64 / 127)
  for (const value of [0, 64 / 127, 1]) axis.set(value)
  assert.deepEqual(values, [-36, 0, 6])
})
