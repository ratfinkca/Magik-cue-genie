import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/hotCueGesture.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { createHotCueGesture } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

test("a press only finishes once, from its original pad and pointer", () => {
  const gesture = createHotCueGesture()
  const calls = []
  const pad = {}
  const pointer = { kind: "pointer", id: 4 }
  gesture.begin(pad, pointer, () => (reason => calls.push(reason)))
  gesture.finish({}, pointer, "release")
  gesture.finish(pad, { kind: "pointer", id: 5 }, "release")
  assert.deepEqual(calls, [])
  assert.equal(gesture.finish(pad, pointer, "release"), true)
  assert.equal(gesture.finish(pad, pointer, "cancel"), false)
  assert.deepEqual(calls, ["release"])
})

test("a repeated key cannot restart a gesture and blur cancels only the owner", () => {
  const gesture = createHotCueGesture()
  const pad = {}
  const enter = { kind: "keyboard", key: "Enter" }
  const calls = []
  const start = () => {
    calls.push("start")
    return reason => calls.push(reason)
  }
  gesture.begin(pad, enter, start)
  gesture.begin(pad, { ...enter }, start)
  gesture.finish(pad, { kind: "keyboard", key: " " }, "release")
  gesture.cancel({})
  assert.deepEqual(calls, ["start"])
  assert.equal(gesture.cancel(pad), true)
  gesture.finish(pad, enter, "release")
  assert.deepEqual(calls, ["start", "cancel"])
})

test("taking over the same deck cancels the previous gesture before pressing the next pad", () => {
  const gesture = createHotCueGesture()
  const oldPad = {}, newPad = {}
  const pointer = { kind: "pointer", id: 1 }
  const calls = []
  gesture.begin(oldPad, pointer, () => reason => calls.push("first " + reason))
  gesture.begin(newPad, pointer, () => {
    calls.push("next down")
    return reason => calls.push("next " + reason)
  })
  gesture.finish(oldPad, pointer, "release")
  gesture.finish(newPad, pointer, "release")
  assert.deepEqual(calls, ["first cancel", "next down", "next release"])
})

test("cancelling before a nested capture callback leaves no active gesture", () => {
  const gesture = createHotCueGesture()
  const pad = {}
  const pointer = { kind: "pointer", id: 9 }
  const calls = []
  gesture.begin(pad, pointer, () => reason => {
    calls.push(reason)
    assert.equal(gesture.finish(pad, pointer, "cancel"), false)
  })
  assert.equal(gesture.cancel(), true)
  assert.deepEqual(calls, ["cancel"])
})
