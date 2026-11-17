import { useRef, useState } from "react"
import { MAX_BACKUP_BYTES, parseStudioBackup, readStudioBackup, restoreStudioBackup } from "./studioBackupData"
import type { StudioBackupDocument } from "./studioBackupData"
import "./studioBackup.css"

const pickerType = { description: "Cue Studio backup", accept: { "application/json": [".json"] } }
type PickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: typeof pickerType[] }) => Promise<FileSystemFileHandle>
  showOpenFilePicker?: (options: { types: typeof pickerType[] }) => Promise<FileSystemFileHandle[]>
}

function inaccessiblePicker(error: unknown) {
  return error instanceof DOMException && (error.name === "SecurityError" || error.name === "NotSupportedError")
}

function downloadBackup(file: Blob, filename: string) {
  const url = URL.createObjectURL(file)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function StudioBackup() {
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const readVersion = useRef(0)
  const [exportFile, setExportFile] = useState<{ blob: Blob; name: string } | null>(null)
  const [candidate, setCandidate] = useState<StudioBackupDocument | null>(null)
  const [replaceMatched, setReplaceMatched] = useState(false)
  const [restorePreferences, setRestorePreferences] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [reload, setReload] = useState(false)

  async function refreshExport() {
    const version = ++readVersion.current
    setExportFile(null)
    try {
      const backup = await readStudioBackup()
      if (version !== readVersion.current) return
      const blob = new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" })
      if (blob.size > MAX_BACKUP_BYTES) throw new Error("This library backup exceeds 128 MiB.")
      setExportFile({ blob, name: `magik-cue-studio-${backup.exported_at.replace(/[:.]/g, "-")}.json` })
    } catch (error) {
      if (version === readVersion.current) setStatus(error instanceof Error ? error.message : "Could not read the local library.")
    }
  }

  function close() {
    readVersion.current++
    setExportFile(null)
    setCandidate(null)
    setStatus("")
  }

  async function save() {
    if (!exportFile) return
    setBusy(true)
    setStatus("")
    try {
      const picker = (window as PickerWindow).showSaveFilePicker
      let handle: FileSystemFileHandle | undefined
      if (picker) {
        try { handle = await picker.call(window, { suggestedName: exportFile.name, types: [pickerType] }) }
        catch (error) { if (!inaccessiblePicker(error)) throw error }
      }
      if (handle) {
        const writable = await handle.createWritable()
        try {
          await writable.write(exportFile.blob)
          await writable.close()
        } catch (error) {
          await writable.abort().catch(() => {})
          throw error
        }
      } else downloadBackup(exportFile.blob, exportFile.name)
      setStatus(handle ? "Backup saved." : "Backup download started.")
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setStatus("Could not save this backup file.")
    } finally { setBusy(false) }
  }

  async function inspect(file: File) {
    setBusy(true)
    setCandidate(null)
    setStatus("")
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error("Choose a backup up to 128 MiB.")
      setCandidate(parseStudioBackup(await file.text()))
      setReplaceMatched(false)
      setRestorePreferences(true)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read this backup.")
    } finally { setBusy(false) }
  }

  async function openBackup() {
    const picker = (window as PickerWindow).showOpenFilePicker
    if (!picker) { fileInput.current?.click(); return }
    try {
      const [handle] = await picker.call(window, { types: [pickerType] })
      if (handle) await inspect(await handle.getFile())
    } catch (error) {
      if (inaccessiblePicker(error)) fileInput.current?.click()
      else if (!(error instanceof DOMException && error.name === "AbortError")) setStatus("Could not open this backup file.")
    }
  }

  async function restore() {
    if (!candidate) return
    setBusy(true)
    setStatus("")
    try {
      const result = await restoreStudioBackup(candidate, { replaceMatched, restorePreferences })
      const parts = [`${result.tracksAdded} new track${result.tracksAdded === 1 ? "" : "s"}`,
        `${result.preparationRestored} restored preparation${result.preparationRestored === 1 ? "" : "s"}`,
        `${result.playlistsRestored} restored playlist${result.playlistsRestored === 1 ? "" : "s"}`]
      const kept = result.preparationKept + result.playlistsKept
      if (kept) parts.push(`${kept} kept from this library`)
      if (result.needsAudio) parts.push(`${result.needsAudio} need matching audio`)
      setStatus(`${parts.join(" · ")}.${result.preferencesFailed ? " Some settings could not be written." : ""}`)
      if (result.preferencesRestored) setReload(true)
      setCandidate(null)
      void refreshExport()
    } catch { setStatus("Could not restore this backup. Check browser storage and try again.") }
    finally { setBusy(false) }
  }

  return <>
    <button className="quiet" type="button" onClick={() => {
      dialog.current?.showModal()
      void refreshExport()
    }}>Backup</button>
    <dialog className="studio-backup" ref={dialog} aria-labelledby="studio-backup-title" onClose={close}
      onCancel={event => { if (busy) event.preventDefault() }}>
      <div className="studio-backup-heading">
        <h2 id="studio-backup-title">Library backup</h2>
        <button className="quiet" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <p>Save track entries, cue preparation, playlists, and settings in a local JSON file. Keep your audio files and add matching copies to relink tracks after restoring.</p>
      <div className="studio-backup-actions">
        <button className="quiet" type="button" disabled={busy || !exportFile} onClick={() => void save()}>Save backup JSON</button>
        <button className="quiet" type="button" disabled={busy} onClick={() => void openBackup()}>Open backup JSON</button>
        <input type="file" hidden accept=".json,application/json" ref={fileInput} onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file) void inspect(file)
        }} />
      </div>
      {candidate && <div className="studio-backup-confirm">
        <p>{new Date(candidate.exported_at).toLocaleString()} · {candidate.tracks.length} tracks · {candidate.playlists.length} playlists · {candidate.tracks.filter(item => item.preparation).length} prepared</p>
        <label><input type="checkbox" checked={replaceMatched} disabled={busy}
          onChange={event => setReplaceMatched(event.currentTarget.checked)} /> Replace saved preparation and playlists with matching IDs</label>
        <label><input type="checkbox" checked={restorePreferences} disabled={busy || !Object.keys(candidate.preferences).length}
          onChange={event => setRestorePreferences(event.currentTarget.checked)} /> Restore settings on next reload</label>
        <button className="quiet" type="button" disabled={busy} onClick={() => void restore()}>Restore backup</button>
      </div>}
      {status && <p role="status">{status}</p>}
      {reload && <div className="studio-backup-actions">
        <p>Restored settings apply after reloading.</p>
        <button className="quiet" type="button" disabled={busy} onClick={() => window.location.reload()}>Reload Studio</button>
      </div>}
    </dialog>
  </>
}
