import { Component, useState } from "react"
import type { ReactNode } from "react"
import { clearDiagnostics, downloadDiagnostics } from "./studioDiagnostics"
import "./studioDiagnostics.css"

export function StudioDiagnostics({ forgetDecks }: { forgetDecks: () => Promise<boolean> }) {
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)

  return <details className="studio-diagnostics" onToggle={() => setStatus("")} onKeyDown={event => {
    if (event.key === "Escape" && event.currentTarget.open) {
      event.currentTarget.open = false
      event.currentTarget.querySelector("summary")?.focus()
    }
  }}>
    <summary>Diagnostics</summary>
    <div className="studio-diagnostics-panel">
      <p>Recent errors and session events are logged on this device. The export contains no audio or track names.</p>
      <div className="studio-diagnostics-actions">
        <button className="quiet" type="button" onClick={downloadDiagnostics}>Download log</button>
        <button className="quiet" type="button" onClick={() => {
          clearDiagnostics()
          setStatus("Diagnostic log cleared.")
        }}>Clear log</button>
      </div>
      <button className="quiet" type="button" disabled={busy} onClick={async () => {
        setBusy(true)
        try {
          setStatus(await forgetDecks() ? "Saved deck copies removed." : "Could not remove saved deck copies.")
        } catch {
          setStatus("Could not remove saved deck copies.")
        } finally {
          setBusy(false)
        }
      }}>Forget saved decks</button>
      <p role="status">{status}</p>
    </div>
  </details>
}

export class StudioErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="panel studio-recovery">
      <h1>Cue Studio stopped unexpectedly</h1>
      <p>You can download the local diagnostic log before reloading.</p>
      <div className="studio-diagnostics-actions">
        <button className="primary" type="button" onClick={() => window.location.reload()}>Reload Studio</button>
        <button className="quiet" type="button" onClick={downloadDiagnostics}>Download log</button>
      </div>
    </main>
  }
}
