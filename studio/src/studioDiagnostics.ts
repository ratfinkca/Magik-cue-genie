type Level = "info" | "warn" | "error"
type Details = Record<string, string | number | boolean | null>
type Entry = { at: string; level: Level; event: string; details?: Details }

const logKey = "magik.studio.diagnostics.v1"
const activeKey = "magik.studio.page-active.v1"
const limit = 120
let volatile: Entry[] = []
let installed = false
let storageFailed = false

export function readDiagnostics(): Entry[] {
  if (storageFailed) return volatile
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(logKey) ?? "[]")
    if (Array.isArray(entries)) return entries.slice(-limit)
  } catch { /* The current page can still collect and export events. */ }
  return volatile
}

export function recordDiagnostic(level: Level, event: string, details?: Details) {
  volatile = [...readDiagnostics().slice(-(limit - 1)), { at: new Date().toISOString(), level, event, details }]
  try {
    localStorage.setItem(logKey, JSON.stringify(volatile))
    storageFailed = false
  } catch {
    storageFailed = true
  }
}

export function clearDiagnostics() {
  volatile = []
  try { localStorage.removeItem(logKey) } catch { storageFailed = true }
}

function studioLocation(input: string) {
  return input.match(/\/(?:src|assets)\/[a-z0-9_./-]+\.(?:tsx?|m?js)(?::\d+:\d+)?/i)?.[0] ?? null
}

export function diagnosticError(cause: unknown): Details {
  const error = cause instanceof Error || (typeof DOMException !== "undefined" && cause instanceof DOMException)
    ? cause : null
  const name = error?.name
  // Error messages from decoders and the analyzer can contain paths or filenames.
  const message = error?.message.match(/^Cannot (?:read|set) properties of (?:undefined|null) \((?:reading|setting) '[a-z0-9_]{1,50}'\)$/i)?.[0] ?? null
  return {
    errorType: name && /^[a-z][a-z0-9]{0,40}$/i.test(name) ? name : "Unknown",
    message,
    location: studioLocation(error?.stack?.split("\n").slice(1).join("\n") ?? ""),
  }
}

export function installStudioDiagnostics(build: string) {
  if (installed) return
  installed = true
  try {
    if (sessionStorage.getItem(activeKey) === "active") recordDiagnostic("warn", "page.interrupted")
    sessionStorage.setItem(activeKey, "active")
  } catch { /* Private browsing can disable storage. */ }
  recordDiagnostic("info", "page.started", { build })

  window.addEventListener("pagehide", () => {
    try { sessionStorage.removeItem(activeKey) } catch { /* Optional browser storage. */ }
    recordDiagnostic("info", "page.hidden")
  })
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return
    try { sessionStorage.setItem(activeKey, "active") } catch { /* Optional browser storage. */ }
    recordDiagnostic("info", "page.resumed")
  })
  window.addEventListener("error", event => {
    const error = diagnosticError(event.error)
    const location = studioLocation(event.filename ?? "")
    recordDiagnostic("error", "browser.error", {
      ...error,
      location: error.location ?? location,
      line: event.lineno || null,
      column: event.colno || null,
    })
  })
  window.addEventListener("unhandledrejection", event => {
    recordDiagnostic("error", "browser.rejection", diagnosticError(event.reason))
  })
}

export function downloadDiagnostics() {
  const report = { version: 1, exportedAt: new Date().toISOString(), entries: readDiagnostics() }
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "cue-studio-diagnostics.json"
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
