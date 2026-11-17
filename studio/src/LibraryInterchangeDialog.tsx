import { useId, useMemo, useRef, useState } from "react"
import type { InterchangeLibrary } from "./interchangeTypes"
import type { InterchangeSource, MediaAssignment } from "./libraryInterchange"
import type { DecodeForPreparation } from "./libraryPreparation"
import { libraryMediaMatcher } from "./playlistInterchange"
import type { LibraryTrack } from "./trackLibrary"
import type { TrackPlaylist } from "./trackPlaylist"
import "./libraryInterchange.css"

const previewSize = 18
type DirectoryPickerWindow = Window & { showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle> }

export default function LibraryInterchangeDialog({ tracks, playlists, selectedPlaylist, disabled, decode }: {
  tracks: LibraryTrack[]; playlists: TrackPlaylist[]; selectedPlaylist?: string; disabled: boolean; decode: DecodeForPreparation
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const playlistFile = useRef<HTMLInputElement>(null)
  const audioFile = useRef<HTMLInputElement>(null)
  const audioTarget = useRef<string>("")
  const titleId = useId()
  const [mode, setMode] = useState<"import" | "export">("import")
  const [source, setSource] = useState<{ source: InterchangeSource; data: InterchangeLibrary } | null>(null)
  const [overrides, setOverrides] = useState<ReadonlyMap<string, MediaAssignment | null>>(new Map())
  const [page, setPage] = useState(0)
  const [targetPlaylist, setTargetPlaylist] = useState("")
  const [includeXml, setIncludeXml] = useState(false)
  const [parent, setParent] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [warnings, setWarnings] = useState<string[]>([])
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  const chosenPlaylist = playlists.find(item => item.id === targetPlaylist)
  const match = useMemo(() => libraryMediaMatcher(tracks), [tracks])
  const proposed = useMemo(() => source?.data.tracks.map(item => ({ item, ...match(item.location) })) ?? [], [source, match])
  const assignments = useMemo(() => {
    const resolved = new Map<string, MediaAssignment>()
    for (const { item, match } of proposed) {
      const assignment = overrides.has(item.id) ? overrides.get(item.id) : match && { libraryId: match.id }
      if (assignment) resolved.set(item.id, assignment)
    }
    return resolved
  }, [overrides, proposed])

  function assign(id: string, value: MediaAssignment | null) {
    setOverrides(previous => new Map(previous).set(id, value))
  }

  async function openFile(file: File) {
    setBusy(true)
    setSource(null)
    setOverrides(new Map())
    setPage(0)
    setMessage("")
    setWarnings([])
    try {
      const { inspectInterchangeFile } = await import("./libraryInterchange")
      const result = await inspectInterchangeFile(file)
      setSource(result)
      setWarnings(result.data.warnings)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not open the import file.")
    } finally { setBusy(false) }
  }

  async function applyImport() {
    if (!source || !assignments.size || busy) return
    setBusy(true)
    setMessage("Importing matched tracks…")
    try {
      const { importInterchangePlaylists } = await import("./libraryInterchange")
      const result = await importInterchangePlaylists(source.data, source.source, assignments, decode)
      setMessage(`${result.tracks} tracks matched. ${result.playlists} playlists added, ${result.unchangedPlaylists} already matched. ${result.preparations} preparations added, ${result.kept} kept.`)
      setWarnings([...source.data.warnings, ...result.warnings])
      if (result.tracks === proposed.length && !result.warnings.length) {
        setSource(null)
        setOverrides(new Map())
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not import the selected playlists.")
    } finally { setBusy(false) }
  }

  async function saveExport() {
    if (!chosenPlaylist?.trackIds.length || !picker || busy) return
    setBusy(true)
    setMessage("")
    setWarnings([])
    try {
      const directory = await picker.call(window, { mode: "readwrite" })
      const { stagePlaylistExport, exportParentPath } = await import("./libraryInterchange")
      const xmlParent = includeXml ? exportParentPath(parent) : null
      const isRoot = xmlParent === "/" || /^[a-z]:\/$/i.test(xmlParent ?? "")
      if (includeXml && (!xmlParent || (!isRoot && xmlParent.split("/").at(-2)?.toLowerCase() !== directory.name.toLowerCase()))) {
        throw new Error("For rekordbox XML, enter the full path of the same folder you choose in the picker.")
      }
      const result = await stagePlaylistExport(directory, chosenPlaylist, xmlParent, (copied, total) => {
        setMessage(`Copied ${copied} of ${total} tracks…`)
      })
      setMessage(`Saved ${result.tracks} tracks in ${result.name}.`)
      setWarnings(result.warnings)
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setMessage(cause instanceof Error ? cause.message : "Could not export the playlist.")
      }
    } finally { setBusy(false) }
  }

  return <>
    <button className="quiet" type="button" disabled={disabled} onClick={() => {
      setTargetPlaylist(selectedPlaylist ?? playlists[0]?.id ?? "")
      setMode(selectedPlaylist ? "export" : "import")
      dialog.current?.showModal()
    }}>Import / export</button>
    <dialog className="library-interchange" ref={dialog} aria-labelledby={titleId} onCancel={event => {
      if (busy) event.preventDefault()
    }}>
      <div className="library-interchange-heading">
        <h2 id={titleId}>Library import and export</h2>
        <button className="quiet" type="button" disabled={busy} onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <div className="segments" aria-label="Import and export mode" role="group">
        <button type="button" aria-pressed={mode === "import"} disabled={busy} onClick={() => {
          setMode("import"); setMessage(""); setWarnings(source?.data.warnings ?? [])
        }}>Import</button>
        <button type="button" aria-pressed={mode === "export"} disabled={busy} onClick={() => {
          setMode("export"); setMessage(""); setWarnings([])
        }}>Export</button>
      </div>
      {mode === "import" ? <>
        <div className="library-interchange-actions">
          <button className="quiet" type="button" disabled={busy} onClick={() => playlistFile.current?.click()}>Open playlist file</button>
          <span>M3U, M3U8 or rekordbox XML</span>
        </div>
        <input type="file" hidden accept=".m3u,.m3u8,.xml" ref={playlistFile} onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file) void openFile(file)
        }} />
        <input type="file" hidden accept="audio/*,.aif,.aiff,.flac,.m4a,.mp3,.ogg,.wav" ref={audioFile} onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (file && audioTarget.current) assign(audioTarget.current, { file })
        }} />
        {source && <>
          <p className="library-interchange-count">{source.data.playlists.length} playlists · {assignments.size} of {proposed.length} tracks linked</p>
          <p>Review the matches. Choose audio for any missing track you want to bring in.</p>
          <ul className="library-interchange-preview">
            {proposed.slice(page * previewSize, (page + 1) * previewSize).map(({ item, candidates }) => {
              const assignment = assignments.get(item.id)
              const selectedId = assignment && "libraryId" in assignment ? assignment.libraryId : ""
              return <li key={item.id}>
                <div><strong>{item.title}</strong><span title={item.location}>{item.location}</span></div>
                <div className="library-interchange-choice">
                  {assignment && "file" in assignment ? <span title={assignment.file.name}>{assignment.file.name}</span>
                    : candidates.length > 0 && <select aria-label={`Library audio for ${item.title}`} value={selectedId} disabled={busy}
                      onChange={event => assign(item.id, event.currentTarget.value ? { libraryId: event.currentTarget.value } : null)}>
                      <option value="">Unlinked</option>
                      {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>
                        {candidate.relativePath ?? candidate.fileName}{candidate.duration ? ` · ${Math.round(candidate.duration)} s` : ""}
                      </option>)}
                    </select>}
                  <button className="quiet" type="button" disabled={busy} aria-label={`Choose audio for ${item.title}`} onClick={() => {
                    audioTarget.current = item.id; audioFile.current?.click()
                  }}>Choose audio</button>
                  {assignment && "file" in assignment && <button className="quiet" type="button" disabled={busy}
                    aria-label={`Unlink ${item.title}`} onClick={() => assign(item.id, null)}>Unlink</button>}
                </div>
              </li>
            })}
          </ul>
          {proposed.length > previewSize && <div className="library-interchange-actions">
            <button className="quiet" type="button" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page + 1} of {Math.ceil(proposed.length / previewSize)}</span>
            <button className="quiet" type="button" disabled={busy || (page + 1) * previewSize >= proposed.length}
              onClick={() => setPage(page + 1)}>Next</button>
          </div>}
          <p>Imports linked tracks and keeps existing preparation.</p>
          <button className="primary" type="button" disabled={busy || !assignments.size} onClick={() => void applyImport()}>Import matched tracks</button>
        </>}
      </> : <div className="library-interchange-export">
        <label>Playlist<select value={targetPlaylist} disabled={busy} onChange={event => setTargetPlaylist(event.currentTarget.value)}>
          <option value="">Choose a playlist</option>
          {playlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <p>Creates a fresh folder with audio copies, an M3U8 playlist, and an export report. M3U8 carries track order and paths.</p>
        <label className="library-interchange-check"><input type="checkbox" disabled={busy} checked={includeXml}
          onChange={event => setIncludeXml(event.currentTarget.checked)} /> Include rekordbox XML</label>
        {includeXml && <label>Full path of the destination parent folder
          <input value={parent} disabled={busy} placeholder="C:\Music\Exports" onChange={event => setParent(event.currentTarget.value)} />
        </label>}
        {includeXml && <p>Choose that same folder in the picker. The XML references the audio copies by absolute path.</p>}
        {!picker && <p>Folder export requires a desktop browser with a writable directory picker.</p>}
        <button className="primary" type="button" disabled={busy || !chosenPlaylist?.trackIds.length || !picker || (includeXml && !parent.trim())}
          onClick={() => void saveExport()}>Choose folder and export</button>
      </div>}
      {message && <p className="library-interchange-status" role="status">{message}</p>}
      {warnings.length > 0 && <details className="library-interchange-warnings">
        <summary>{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</summary>
        <ul>{warnings.slice(0, 100).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        {warnings.length > 100 && <p>Showing the first 100 warnings.</p>}
      </details>}
    </dialog>
  </>
}
