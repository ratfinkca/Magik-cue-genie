import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/studioDiagnostics.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { clearDiagnostics, diagnosticError, installStudioDiagnostics, readDiagnostics, recordDiagnostic } =
  await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"))

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

function setGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else delete globalThis[key]
  })
}

test("retains a bounded local history and keeps collecting if browser storage fails", t => {
  const storage = memoryStorage()
  setGlobal(t, "localStorage", storage)
  for (let i = 0; i < 135; i++) recordDiagnostic("info", "playback.event", { index: i })
  assert.equal(readDiagnostics().length, 120)
  assert.equal(readDiagnostics()[0].details.index, 15)
  assert.equal(readDiagnostics().at(-1).details.index, 134)

  const originalWrite = storage.setItem
  storage.setItem = () => { throw new DOMException("Quota full", "QuotaExceededError") }
  recordDiagnostic("warn", "storage.unavailable")
  assert.equal(readDiagnostics().at(-1).event, "storage.unavailable")
  storage.setItem = originalWrite
  recordDiagnostic("info", "storage.available")
  assert.deepEqual(readDiagnostics().slice(-2).map(entry => entry.event), ["storage.unavailable", "storage.available"])
  clearDiagnostics()
  assert.deepEqual(readDiagnostics(), [])
})

test("exports a useful app code location without decoder paths or track names", () => {
  const error = new Error("Failed to decode C:\\Music\\Test-only track.wav")
  error.stack = "Error: " + error.message + "\n    at decode (http://127.0.0.1:4175/assets/index-a1.js:52:194)"
  assert.deepEqual(diagnosticError(error), { errorType: "Error", message: null, location: "/assets/index-a1.js:52:194" })
  assert.deepEqual(diagnosticError("C:\\Music\\Test-only track.wav"), { errorType: "Unknown", message: null, location: null })
})

test("records an interrupted page and distinguishes rejected promises from orderly exit", t => {
  setGlobal(t, "localStorage", memoryStorage())
  const session = memoryStorage()
  setGlobal(t, "sessionStorage", session)
  const fakeWindow = new EventTarget()
  setGlobal(t, "window", fakeWindow)
  session.setItem("magik.studio.page-active.v1", "active")
  installStudioDiagnostics("test")
  fakeWindow.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new TypeError("Private filename.wav") }))
  fakeWindow.dispatchEvent(new Event("pagehide"))
  assert.deepEqual(readDiagnostics().map(entry => entry.event), [
    "page.interrupted", "page.started", "browser.rejection", "page.hidden",
  ])
  assert.equal(session.getItem("magik.studio.page-active.v1"), null)
  assert.equal(readDiagnostics()[2].details.message, null)
})
