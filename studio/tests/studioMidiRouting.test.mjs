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
const { controllerPresets } = await import(moduleUrl(await compile("controllerPresets")))

const note = (inputId, actionId, number = 23) => ({ inputId, actionId, control: { kind: "note", channel: 1, number } })
const cc = (inputId, actionId, number = 11) => ({ inputId, actionId, control: { kind: "cc", channel: 1, number } })
const fineCc = (inputId, actionId, channel = 1) => ({ inputId, actionId,
  control: { kind: "cc", channel, number: 11, lsb: 43 } })

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

test("Mixstream pad modes and Shift select independent decks and release the original held hot cue", () => {
  const preset = controllerPresets.find(item => item.id === 'mixstream-pro-go')
  const router = createStudioMidiRouter()
  const calls = []
  const route = { preset, targets: studioMidiTargets, bindings: preset.bindings.map(binding => ({ ...binding, inputId: 'go' })),
    learning: null, learned() {}, axis() { return null },
    press(action) { calls.push(action); return reason => calls.push(action + ' ' + reason) },
  }
  const send = (status, number, value = 127) => router.receive('go', [status, number, value], route)
  send(0x92, 0x0f)
  send(0x92, 0x0f, 0)
  send(0x92, 0x1c)
  send(0x92, 0x0f)
  send(0x92, 0x1c, 0)
  send(0x92, 0x0f, 0)
  assert.deepEqual(calls, ['A:hot-1', 'A:hot-1 release', 'A:hot-5', 'A:hot-5 release'])
  send(0x92, 0x0e)
  send(0x92, 0x0e, 0)
  send(0x92, 0x10)
  send(0x92, 0x10, 0)
  send(0x93, 0x0f)
  send(0x93, 0x0f, 0)
  assert.deepEqual(calls.slice(-4), ['A:loop-size-8', 'A:loop-size-8 release', 'B:hot-1', 'B:hot-1 release'])
  send(0x92, 0x1c)
  send(0x92, 0x12)
  send(0x92, 0x12, 0)
  send(0x92, 0x1c, 0)
  assert.equal(calls.at(-2), 'A:loop-exit')
  send(0x92, 0x0c)
  send(0x92, 0x0c, 0)
  send(0x92, 0x11)
  send(0x92, 0x11, 0)
  assert.equal(calls.at(-2), 'A:loop-saved-3')
  const beforeRoll = calls.length
  send(0x92, 0x0d)
  send(0x92, 0x0d, 0)
  send(0x92, 0x0f)
  send(0x92, 0x0f, 0)
  assert.equal(calls.length, beforeRoll)
  router.removeInput('go')
  send(0x92, 0x0f)
  assert.equal(calls.at(-1), 'A:hot-1')
})

test("changing a preset or remapping a held conditional pad cancels its audition", () => {
  const preset = controllerPresets.find(item => item.id === 'mixstream-pro-go')
  const router = createStudioMidiRouter()
  const calls = []
  const route = { preset, targets: studioMidiTargets, bindings: preset.bindings.map(binding => ({ ...binding, inputId: 'go' })),
    learning: null, learned() {}, axis() { return null },
    press(action) { calls.push(action); return reason => calls.push(reason) },
  }
  router.receive('go', [0x92, 0x0f, 127], route)
  router.updateBindings(route.bindings)
  assert.deepEqual(calls, ['A:hot-1'])
  route.bindings = route.bindings.filter(binding => binding.actionId !== 'A:hot-1')
  router.updateBindings(route.bindings)
  assert.deepEqual(calls, ['A:hot-1', 'cancel'])
  router.receive('go', [0x92, 0x0f, 0], route)
  assert.deepEqual(calls, ['A:hot-1', 'cancel'])
})

test("learning either half of a preset fader retains the verified precision pair", () => {
  for (const number of [31, 75]) {
    const router = createStudioMidiRouter()
    let learned
    const control = { kind: 'cc', channel: 3, number: 31, lsb: 75 }
    const route = { bindings: [{ inputId: 'go', actionId: 'A:tempo', control, inverted: true }], targets: studioMidiTargets,
      learning: { inputId: 'go', actionId: 'A:filter' }, learned(binding) { learned = binding },
      axis() { throw new Error('learning should consume the movement') }, press() {},
    }
    router.receive('go', [0xb2, number, 40], route)
    assert.deepEqual(learned, { inputId: 'go', actionId: 'A:filter', control, inverted: true })
  }
})

test("editing another mapping preserves the initialized fine stream of an unchanged fader", () => {
  const router = createStudioMidiRouter()
  let position = 0
  const values = []
  const route = { bindings: [{ inputId: 'go', actionId: 'A:tempo', control: { kind: 'cc', channel: 3, number: 31, lsb: 75 } }],
    targets: studioMidiTargets, learning: null, learned() {}, press() {},
    axis() { return { position, set(value) { position = value; values.push(value) } } },
  }
  router.receive('go', [0xb2, 31, 0], route)
  router.receive('go', [0xb2, 75, 0], route)
  route.bindings.push(note('other', 'B:play'))
  router.updateBindings(route.bindings)
  router.receive('go', [0xb2, 75, 1], route)
  assert.deepEqual(values, [0, 1 / 16383])
})

test("14-bit faders initialize from both halves and retain fine values between updates", () => {
  const router = createStudioMidiRouter()
  let position = 0
  const values = []
  const route = { targets: studioMidiTargets, bindings: [fineCc("deck", "M:crossfader")],
    learning: null, learned() {}, press() {},
    axis() { return { position, set(value) { position = value; values.push(value) } } },
  }
  router.receive("deck", [0xb0, 11, 0], route)
  assert.deepEqual(values, [])
  router.receive("deck", [0xb0, 43, 0], route)
  assert.deepEqual(values, [0])
  router.receive("deck", [0xb0, 43, 1], route)
  assert.deepEqual(values, [0, 1 / 16383])
  router.receive("deck", [0xb0, 11, 0], route)
  assert.deepEqual(values, [0, 1 / 16383])
  router.receive("deck", [0xb0, 11, 64], route)
  assert.equal(values.at(-1), 8193 / 16383)
  router.receive("deck", [0xb0, 43, 0], route)
  assert.equal(values.at(-1), 8192 / 16383)
  router.receive("deck", [0xb0, 11, 127], route)
  router.receive("deck", [0xb0, 43, 127], route)
  assert.equal(values.at(-1), 1)
})

test("Mixstream tempo keeps moving when only the fine CC byte changes", () => {
  const router = createStudioMidiRouter()
  let position = 0
  const values = []
  const route = { targets: studioMidiTargets,
    bindings: [{ inputId: "go", actionId: "A:tempo", control: { kind: "cc", channel: 3, number: 31, lsb: 75 } }],
    learning: null, learned() {}, press() {},
    axis() { return { position, set(value) { position = value; values.push(value) } } },
  }
  for (const bytes of [[0xb2, 31, 0], [0xb2, 75, 0], [0xb2, 75, 1], [0xb2, 75, 2]]) {
    router.receive("go", bytes, route)
  }
  assert.deepEqual(values, [0, 1 / 16383, 2 / 16383])

  router.removeInput("go")
  position = 0
  values.length = 0
  router.receive("go", [0xb2, 75, 0], route)
  assert.deepEqual(values, [])
  router.receive("go", [0xb2, 31, 0], route)
  assert.deepEqual(values, [0])
  router.receive("go", [0xb2, 31, 1], route)
  assert.deepEqual(values, [0, 128 / 16383])
})

test("14-bit halves stay isolated by input and channel and are discarded on unplug or remap", () => {
  const router = createStudioMidiRouter()
  const values = []
  const route = { targets: studioMidiTargets,
    bindings: [fineCc("left", "A:tempo"), fineCc("right", "B:tempo"), fineCc("left", "M:crossfader", 2)],
    learning: null, learned() {}, press() {},
    axis(action) { return { position: 0, set(value) { values.push([action, value]) } } },
  }
  router.receive("left", [0xb0, 11, 0], route)
  router.receive("right", [0xb0, 43, 0], route)
  router.receive("left", [0xb1, 43, 0], route)
  assert.deepEqual(values, [])
  router.receive("left", [0xb0, 43, 0], route)
  assert.deepEqual(values, [["A:tempo", 0]])
  router.removeInput("right")
  router.receive("right", [0xb0, 11, 0], route)
  assert.equal(values.length, 1)
  route.bindings[2] = { ...route.bindings[2], actionId: "A:volume" }
  router.updateBindings(route.bindings)
  router.receive("left", [0xb1, 11, 0], route)
  assert.equal(values.length, 1)
  router.receive("left", [0xb1, 43, 0], route)
  assert.deepEqual(values.at(-1), ["A:volume", 0])
})

test("14-bit centered controls keep neutral and fine resolution when inverted", () => {
  const router = createStudioMidiRouter()
  let position = 64 / 127
  const values = []
  const binding = { ...fineCc("deck", "A:tempo"), inverted: true }
  const route = { targets: studioMidiTargets, bindings: [binding], learning: null, learned() {}, press() {},
    axis() { return { position, centered: true, set(value) { position = value; values.push(value) } } },
  }
  const move = value => {
    router.receive("deck", [0xb0, 11, value >> 7], route)
    router.receive("deck", [0xb0, 43, value & 127], route)
  }
  move(8190)
  move(8191)
  assert.deepEqual(values, [])
  move(8192)
  assert.equal(values.at(-1), 64 / 127)
  move(8193)
  assert.ok(values.at(-1) < 64 / 127)
  assert.ok(Math.abs(values.at(-1) - 64 / 127) < 1 / 8192)
  move(0)
  assert.equal(values.at(-1), 1)
  move(16383)
  assert.equal(values.at(-1), 0)
})

test("changing precision or inversion rearms pickup and drops pending halves", () => {
  const router = createStudioMidiRouter()
  let position = 0
  const values = []
  const route = { targets: studioMidiTargets, bindings: [fineCc("deck", "M:crossfader")],
    learning: null, learned() {}, press() {},
    axis() { return { position, set(value) { position = value; values.push(value) } } },
  }
  router.receive("deck", [0xb0, 11, 0], route)
  router.receive("deck", [0xb0, 43, 0], route)
  assert.deepEqual(values, [0])
  router.receive("deck", [0xb0, 11, 0], route)
  route.bindings = [{ ...fineCc("deck", "M:crossfader"), inverted: true }]
  router.updateBindings(route.bindings)
  router.receive("deck", [0xb0, 43, 0], route)
  assert.deepEqual(values, [0])
  router.receive("deck", [0xb0, 11, 0], route)
  assert.deepEqual(values, [0])
})
