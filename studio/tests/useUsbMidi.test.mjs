import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
const mockedReact = dataModule(`
  export function useState(init) {
    const test = globalThis.usbMidiHookTest;
    test.state = init();
    return [test.state, value => { test.state = value }];
  }
  export const useRef = current => ({ current });
  export const useCallback = callback => callback;
  export function useEffect(effect) { globalThis.usbMidiHookTest.unmount = effect() }
`)
const source = await readFile(new URL("../src/useUsbMidi.ts", import.meta.url), "utf8")
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { listenToMidiInputs, useUsbMidi } = await import(dataModule(code.replace('"react"', JSON.stringify(mockedReact))))

class Input extends EventTarget {
  state = "connected"
  manufacturer = "Fixture"
  opens = 0
  closes = 0

  constructor(id, name) {
    super()
    Object.assign(this, { id, name })
  }

  async open() {
    this.opens++
    if (this.failToOpen) throw new Error("Unavailable")
  }

  async close() { this.closes++ }

  send(...bytes) {
    const event = Object.assign(new Event("midimessage"), { data: new Uint8Array(bytes) })
    this.dispatchEvent(event)
    return event.timeStamp
  }
}

function accessWith(...ports) {
  return Object.assign(new EventTarget(), { inputs: new Map(ports.map(port => [port.id, port])) })
}

function restoreGlobal(t, key, value) {
  const old = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    if (old) Object.defineProperty(globalThis, key, old)
    else delete globalThis[key]
  })
}

test("opens and monitors MIDI inputs, forwards bytes, then releases each held port once", async () => {
  const a = new Input("a", "Controller 1")
  const b = new Input("b", " Controller 2 ")
  const access = accessWith(a)
  const received = []
  const removed = []
  let inputs
  const stop = listenToMidiInputs(access, {
    onMessage: (input, bytes, time) => received.push([input.id, Array.from(bytes), time]),
    onInputRemoved: id => removed.push(id),
  }, current => { inputs = current })
  await Promise.resolve()
  assert.deepEqual(inputs.map(port => port.id), ["a"])
  const stamp = a.send(0x90, 5, 127)
  assert.deepEqual(received, [["a", [0x90, 5, 127], stamp]])

  access.inputs.set(b.id, b)
  access.dispatchEvent(new Event("statechange"))
  await Promise.resolve()
  a.state = "disconnected"
  access.dispatchEvent(new Event("statechange"))
  assert.deepEqual(inputs, [{ id: "b", name: "Controller 2", manufacturer: "Fixture" }])
  assert.equal(b.opens, 1)
  assert.deepEqual(removed, ["a"])
  a.send(0x90, 5, 0)
  assert.equal(received.length, 1)
  stop()
  stop()
  assert.deepEqual(removed, ["a", "b"])
  assert.deepEqual([a.closes, b.closes], [1, 1])
  access.dispatchEvent(new Event("statechange"))
  b.send(0x90, 5, 0)
  assert.equal(b.opens, 1)
  assert.equal(received.length, 1)
})

test("permission is requested only by Connect and a late grant cannot revive a disconnected session", async t => {
  let grant
  const requested = []
  const hook = {}
  restoreGlobal(t, "usbMidiHookTest", hook)
  restoreGlobal(t, "navigator", { requestMIDIAccess(options) {
    requested.push(options)
    return new Promise(resolve => { grant = resolve })
  } })
  const device = new Input("a", "Controller")
  const connection = useUsbMidi({ onMessage() {} })
  assert.equal(connection.status, "idle")
  assert.deepEqual(requested, [])
  const pending = connection.connect()
  assert.deepEqual(requested, [{ sysex: false }])
  assert.equal(hook.state.status, "connecting")
  connection.disconnect()
  grant(accessWith(device))
  await pending
  assert.equal(hook.state.status, "idle")
  assert.equal(device.opens, 0)

  const retry = connection.connect()
  grant(accessWith(device))
  await retry
  assert.equal(hook.state.status, "connected")
  assert.equal(hook.state.inputs[0].id, device.id)
  hook.unmount()
  assert.equal(device.closes, 1)
})

test("a permission denial leaves a retryable error without opening an input", async t => {
  const hook = {}
  restoreGlobal(t, "usbMidiHookTest", hook)
  restoreGlobal(t, "navigator", { async requestMIDIAccess() { throw new DOMException("Blocked", "NotAllowedError") } })
  const midi = useUsbMidi({ onMessage() {} })
  await midi.connect()
  assert.equal(hook.state.status, "error")
  assert.match(hook.state.error, /browser permissions/)
  midi.disconnect()
  assert.equal(hook.state.status, "idle")
})

test("an unavailable port reports an error and recovers after reconnect under the same ID", async () => {
  const bad = new Input("a", "DJ Deck")
  bad.failToOpen = true
  const access = accessWith(bad)
  const received = []
  let state
  const stop = listenToMidiInputs(access, { onMessage: input => received.push(input.id) }, (inputs, error) => {
    state = { inputs, error }
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(state.inputs, [])
  assert.match(state.error, /Could not open MIDI input DJ Deck/)
  bad.send(0x90, 1, 127)

  const recovered = new Input(bad.id, bad.name)
  access.inputs.set(bad.id, recovered)
  access.dispatchEvent(new Event("statechange"))
  await Promise.resolve()
  assert.equal(state.error, null)
  assert.deepEqual(state.inputs.map(input => input.id), ["a"])
  recovered.send(0x90, 1, 127)
  assert.deepEqual(received, ["a"])
  stop()
})
