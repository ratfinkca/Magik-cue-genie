import { useState, useSyncExternalStore } from "react"
import "./installStudio.css"

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

const installableBuild = import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator
const listeners = new Set<() => void>()
let installPrompt: InstallPrompt | undefined
let installed = false
let offlineReady = false

function changed() {
  listeners.forEach(notify => notify())
}

if (installableBuild) {
  const displayMode = matchMedia("(display-mode: standalone)")
  installed = displayMode.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  displayMode.addEventListener("change", event => {
    if (event.matches) { installed = true; changed() }
  })
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault()
    installPrompt = event as InstallPrompt
    changed()
  })
  window.addEventListener("appinstalled", () => {
    installed = true
    installPrompt = undefined
    changed()
  })
  void navigator.serviceWorker.ready.then(() => {
    offlineReady = true
    changed()
  })
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

function status() {
  if (!installableBuild || installed) return "hidden"
  if (installPrompt) return "prompt"
  return offlineReady ? "ready" : "waiting"
}

export function InstallStudio() {
  const install = useSyncExternalStore(subscribe, status)
  const [showHelp, setShowHelp] = useState(false)
  if (install === "hidden") return null

  async function openInstall() {
    const prompt = installPrompt
    if (!prompt) {
      setShowHelp(previous => !previous)
      return
    }
    installPrompt = undefined
    setShowHelp(false)
    changed()
    try {
      await prompt.prompt()
      if ((await prompt.userChoice).outcome === "accepted") {
        installed = true
        changed()
      }
    } catch {
      setShowHelp(true)
    }
  }

  return <div className="studio-install" onKeyDown={event => { if (event.key === "Escape") setShowHelp(false) }}>
    <button className="quiet" type="button" aria-expanded={install === "prompt" ? undefined : showHelp}
      aria-controls={install === "prompt" ? undefined : "studio-install-help"} onClick={() => void openInstall()}>
      {install === "prompt" ? "Install Studio" : "Install options"}
    </button>
    <div className="studio-install-help" id="studio-install-help" hidden={!showHelp}>
      <p>Use your browser’s <strong>Install app</strong> or <strong>Add to Home Screen</strong> command.</p>
      <p>{install === "ready" ? "Studio is ready to open offline. New analysis still needs the local service."
        : "Keep the local preview running for the first launch while Studio prepares its offline files."}</p>
    </div>
  </div>
}
