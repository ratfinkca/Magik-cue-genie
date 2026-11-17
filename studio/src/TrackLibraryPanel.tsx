import { ArrowDownIcon, ArrowUpIcon, ArrowsLeftRightIcon, CaretDownIcon, CaretRightIcon, FileAudioIcon, FolderIcon, FolderOpenIcon, FunnelSimpleIcon, MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon, QueueIcon, TrashIcon, XIcon } from "@phosphor-icons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import { formatTime } from "./cues"
import LibraryFilterBuilder from "./LibraryFilterBuilder"
import LibraryInterchangeDialog from "./LibraryInterchangeDialog"
import { compileLibraryFilters, LIBRARY_FILTER_FIELDS, newLibraryFilterRule } from "./libraryFilters"
import type { LibraryFilterField, LibraryFilterRule, LibraryMatchMode } from "./libraryFilters"
import { prepareLibraryTrack } from "./libraryPreparation"
import type { DecodeForPreparation, LibraryPreparationKind } from "./libraryPreparation"
import { studioLocalBackendAvailable } from "./localBackend"
import { readStudioPreferences } from "./studioPreferences"
import { compareTrackCompatibility } from "./trackCompatibility"
import { backfillLibraryPrepSummaries, refreshLibraryGenres, setLibraryReviewStatus } from "./trackLibrary"
import type { LibraryTrack } from "./trackLibrary"
import { addTracksToPlaylist, createTrackPlaylist, moveTrackInPlaylist, readTrackPlaylists,
  removeTrackFromPlaylist, removeTrackPlaylist, renameTrackPlaylist, subscribeTrackPlaylists } from "./trackPlaylist"
import type { TrackPlaylist } from "./trackPlaylist"
import type { DeckId } from "./transitionAudio"
import "./trackLibraryPanel.css"

const pageSize = 50
const decks: DeckId[] = ["A", "B"]
const fileTypes = "audio/*,.aif,.aiff,.flac,.m4a,.mp3,.ogg,.opus,.wav"
const matchLevelLabels = { close: "Close", possible: "Possible", distant: "Distant", limited: "Limited data" }
type Scope = { kind: "all" } | { kind: "folder"; path: string } | { kind: "playlist"; id: string }
type AddResult = { added: number; existing: number; failed: number; skipped?: number; relinked?: number }
type FolderNode = { path: string; name: string; children: FolderNode[] }
type BatchProgress = { kind: LibraryPreparationKind; title: string; finished: number; total: number; stopping?: boolean }
interface Props {
  tracks: LibraryTrack[]
  status: "loading" | "ready" | "unavailable"
  notice: string | null
  loaded: Record<DeckId, string | undefined>
  busyDecks: Record<DeckId, boolean>
  addTracks: (files: File[]) => Promise<AddResult>
  loadTrack: (deck: DeckId, id: string) => Promise<boolean>
  removeTrack: (id: string) => Promise<boolean>
  decodeForPreparation: DecodeForPreparation
}

function trackTitle(track: LibraryTrack) { return track.title || track.name }

function libraryFolders(tracks: LibraryTrack[]) {
  const folders = new Map<string, FolderNode>()
  const roots: FolderNode[] = []
  const pathsById = new Map<string, string[]>()
  for (const track of tracks) {
    const paths = [...new Set([...(track.relativePaths ?? []), ...(track.relativePath ? [track.relativePath] : [])])]
    pathsById.set(track.id, paths)
    for (const path of paths) {
      let parent: FolderNode | undefined
      for (const name of path.split("/").slice(0, -1)) {
        const branchPath: string = parent ? parent.path + "/" + name : name
        let branch = folders.get(branchPath)
        if (!branch) {
          branch = { path: branchPath, name, children: [] }
          folders.set(branchPath, branch)
          const siblings = parent?.children ?? roots
          siblings.push(branch)
        }
        parent = branch
      }
    }
  }
  const sort = (branches: FolderNode[]) => branches.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  for (const branch of folders.values()) sort(branch.children)
  return { pathsById, folders: sort(roots) }
}

export default function TrackLibraryPanel({ tracks, status, notice, loaded, busyDecks, addTracks, loadTrack, removeTrack,
  decodeForPreparation }: Props) {
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const filtersPanel = useRef<HTMLDivElement>(null)
  const filterId = useRef(0)
  const batchTask = useRef<AbortController | null>(null)
  const summariesSeen = useRef(new Set<string>())
  const selectAll = useRef<HTMLInputElement>(null)
  const [scope, setScope] = useState<Scope>({ kind: "all" })
  const [query, setQuery] = useState("")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filters, setFilters] = useState<LibraryFilterRule[]>([])
  const [filterMode, setFilterMode] = useState<LibraryMatchMode>("all")
  const [refreshingGenres, setRefreshingGenres] = useState(false)
  const [page, setPage] = useState(0)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const [playlists, setPlaylists] = useState<TrackPlaylist[]>([])
  const [playlistError, setPlaylistError] = useState(false)
  const [playlistBusy, setPlaylistBusy] = useState(false)
  const [playlistEditor, setPlaylistEditor] = useState<{ id: string | null; name: string } | null>(null)
  const [addTo, setAddTo] = useState("")
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set())
  const [reviewPending, setReviewPending] = useState<Set<string>>(() => new Set())
  const [batch, setBatch] = useState<BatchProgress | null>(null)
  const [batchFailures, setBatchFailures] = useState<{ name: string; message: string }[]>([])
  const [referenceId, setReferenceId] = useState<string | null>(null)
  const tracksById = useMemo(() => new Map(tracks.map(track => [track.id, track])), [tracks])
  const referenceTrack = referenceId ? tracksById.get(referenceId) : undefined
  const { pathsById, folders } = useMemo(() => libraryFolders(tracks), [tracks])
  const folder = scope.kind === "folder" ? scope.path : undefined
  const playlist = scope.kind === "playlist" ? playlists.find(item => item.id === scope.id) : undefined
  const title = folder ? folder.split("/").at(-1) : playlist?.name ?? "All tracks"
  const playlistOrder = useMemo(() => new Map(playlist?.trackIds.map((id, index) => [id, index])), [playlist])
  const selection = [...checked].filter(id => tracksById.has(id))
  const readySelection = selection.filter(id => !tracksById.get(id)?.needsAudio)
  const missingGenres = useMemo(() => tracks.filter(track => track.genres === undefined).map(track => track.id), [tracks])
  const matcher = useMemo(() => compileLibraryFilters(filters, filterMode), [filters, filterMode])
  const visible = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const entries = playlist ? playlist.trackIds.flatMap(id => tracksById.get(id) ?? []) : tracks
    return entries.filter(track => {
      const paths = pathsById.get(track.id) ?? []
      if (folder && !paths.some(path => path.startsWith(folder + "/"))) return false
      const text = [track.name, track.fileName, track.artist, track.title, track.key, ...(track.genres ?? []), ...paths]
        .filter(Boolean).join(" ").toLowerCase()
      return terms.every(term => text.includes(term)) && matcher.matches(track)
    })
  }, [folder, playlist, query, tracks, tracksById, pathsById, matcher])
  const lastPage = Math.max(0, Math.ceil(visible.length / pageSize) - 1)
  const currentPage = Math.min(page, lastPage)
  const first = currentPage * pageSize
  const visibleSelected = visible.filter(track => checked.has(track.id)).length

  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = visibleSelected > 0 && visibleSelected < visible.length
  }, [visibleSelected, visible.length])

  useEffect(() => {
    const missing = tracks.filter(track => track.prepared && (track.analysisStatus === undefined
      || track.cueCount === undefined || track.matchEvidence === undefined)
      && !summariesSeen.current.has(track.id)).map(track => track.id)
    if (!missing.length) return
    for (const id of missing) summariesSeen.current.add(id)
    void backfillLibraryPrepSummaries(missing).catch(() => {})
  }, [tracks])

  useEffect(() => () => batchTask.current?.abort(), [])

  useEffect(() => {
    let active = true
    let latest = 0
    function refresh() {
      const version = ++latest
      void readTrackPlaylists().then(items => {
        if (!active || version !== latest) return
        setPlaylists(items)
        setPlaylistError(false)
      }).catch(() => {
        if (active && version === latest) setPlaylistError(true)
      })
    }
    const stop = subscribeTrackPlaylists(refresh)
    refresh()
    return () => { active = false; stop() }
  }, [])

  function browse(next: Scope) {
    setScope(next)
    setPage(0)
  }

  function addFilter(field: LibraryFilterField) {
    const rule = newLibraryFilterRule(++filterId.current, field)
    setFilters(current => [...current, rule])
  }

  function filterColumn(field: LibraryFilterField) {
    setFiltersOpen(true)
    if (!filters.some(rule => rule.field === field)) addFilter(field)
    requestAnimationFrame(() => {
      const row = filtersPanel.current?.querySelector(`[data-filter-field="${field}"]`)
      const input = row?.querySelector<HTMLElement>("[data-filter-value]") ?? row?.querySelector<HTMLElement>("select")
      input?.focus()
    })
  }

  function columnFilter(field: LibraryFilterField) {
    return <button className="track-library-column-filter" type="button" aria-label={"Filter " + LIBRARY_FILTER_FIELDS[field]}
      aria-controls="track-library-filters" data-active={matcher.activeFields.has(field)} onClick={() => filterColumn(field)}>
      {LIBRARY_FILTER_FIELDS[field]}<FunnelSimpleIcon aria-hidden="true" />
    </button>
  }

  async function refreshGenres() {
    if (refreshingGenres) return
    setRefreshingGenres(true)
    setFeedback("")
    try {
      const result = await refreshLibraryGenres(missingGenres)
      const parts = [result.tagged ? result.tagged + " with genre tags" : "",
        result.untagged ? result.untagged + " without a readable genre tag" : "",
        result.unavailable ? result.unavailable + " unavailable" : ""].filter(Boolean)
      setFeedback(parts.join(" · ") || "Genre tags are up to date.")
    } catch {
      setFeedback("Could not refresh embedded genre tags.")
    } finally { setRefreshingGenres(false) }
  }

  async function add(files: File[], rootFolder?: string) {
    if (!files.length || importing) return
    setImporting(true)
    setFeedback("")
    try {
      const result = await addTracks(files)
      const summary = [result.added ? result.added + " added" : "",
        result.relinked ? result.relinked + " audio files linked" : "",
        result.existing ? result.existing + " already in library" : "",
        result.skipped ? result.skipped + " unsupported or non-audio files skipped" : "",
        result.failed ? result.failed + " could not be added" : "",
      ].filter(Boolean)
      if (rootFolder && (result.added || result.existing || result.relinked)) {
        setExpandedFolders(current => new Set(current).add(rootFolder))
        browse({ kind: "folder", path: rootFolder })
      }
      setFeedback(summary.join(" · ") || "No supported audio files found.")
    } catch {
      setFeedback("Could not add tracks to the library.")
    } finally {
      setImporting(false)
    }
  }

  async function load(deck: DeckId, track: LibraryTrack) {
    setFeedback("")
    try {
      if (await loadTrack(deck, track.id)) setFeedback(trackTitle(track) + " loaded on Deck " + deck + ".")
    } catch { setFeedback("Could not load this track on Deck " + deck + ".") }
  }

  async function remove(track: LibraryTrack) {
    if (!window.confirm("Remove this library copy and its saved cues, loops, and beatgrid? Your original audio file stays on disk.")) return
    setRemoving(track.id)
    try {
      setFeedback(await removeTrack(track.id) ? "Track removed from the library." : "Could not remove this library copy.")
    } catch {
      setFeedback("Could not remove this library copy.")
    } finally {
      setRemoving(null)
    }
  }

  async function editPlaylist(work: () => Promise<void>, failure: string) {
    if (playlistBusy) return
    setPlaylistBusy(true)
    setFeedback("")
    try { await work() }
    catch { setFeedback(failure) }
    finally { setPlaylistBusy(false) }
  }

  async function savePlaylistName() {
    if (!playlistEditor?.name.trim()) return
    const { id, name } = playlistEditor
    await editPlaylist(async () => {
      if (id !== null) {
        const updated = await renameTrackPlaylist(id, name)
        if (!updated) throw new Error("Playlist unavailable")
        setPlaylists(items => items.map(item => item.id === updated.id ? updated : item))
        setPlaylistEditor(null)
        setFeedback("Playlist renamed.")
        return
      }
      const created = await createTrackPlaylist(name, selection)
      setPlaylists(items => items.some(item => item.id === created.id) ? items : [...items, created])
      setChecked(new Set())
      setPlaylistEditor(null)
      setQuery("")
      browse({ kind: "playlist", id: created.id })
      setFeedback("Playlist created.")
    }, id === null ? "Could not create this playlist." : "Could not rename this playlist.")
  }

  async function addSelection() {
    const target = playlists.find(item => item.id === addTo)
    if (!target || !selection.length) return
    await editPlaylist(async () => {
      const updated = await addTracksToPlaylist(target.id, selection)
      if (!updated) throw new Error("Playlist unavailable")
      const prior = new Set(target.trackIds)
      const current = new Set(updated.trackIds)
      const count = selection.filter(id => current.has(id) && !prior.has(id)).length
      setPlaylists(items => items.map(item => item.id === updated.id ? updated : item))
      setFeedback(count ? count + (count === 1 ? " track added to " : " tracks added to ") + target.name + "."
        : selection.some(id => current.has(id)) ? "The available tracks are already in this playlist."
          : "The selected tracks are no longer available.")
      setChecked(new Set())
    }, "Could not add every selected track to this playlist.")
  }

  function toggleTrack(id: string) {
    setChecked(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setChecked(previous => {
      const next = new Set(previous)
      for (const track of visible) {
        if (visibleSelected === visible.length) next.delete(track.id)
        else next.add(track.id)
      }
      return next
    })
  }

  async function changeReview(id: string, value: string) {
    setReviewPending(current => new Set(current).add(id))
    try { await setLibraryReviewStatus(id, value === "reviewed" || value === "approved" ? value : undefined) }
    catch { setFeedback("Could not save the track’s review status.") }
    finally {
      setReviewPending(current => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  async function prepareSelection(kind: LibraryPreparationKind) {
    if (batchTask.current || !readySelection.length || !studioLocalBackendAvailable()) return
    const tracks = readySelection.flatMap(id => tracksById.get(id) ?? [])
    const task = new AbortController()
    batchTask.current = task
    const { analysis } = readStudioPreferences()
    const failed: { name: string; message: string }[] = []
    setFeedback("")
    setBatchFailures([])
    let finished = 0
    try {
      for (const track of tracks) {
        task.signal.throwIfAborted()
        const name = trackTitle(track)
        setBatch({ kind, title: name, finished, total: tracks.length })
        try { await prepareLibraryTrack(track.id, kind, decodeForPreparation, analysis, task.signal) }
        catch (cause) {
          task.signal.throwIfAborted()
          failed.push({ name, message: cause instanceof Error ? cause.message : "The local worker could not prepare it." })
        }
        finished++
      }
    } catch {
      // Cancel stops the queue and retains any items that already completed.
    } finally {
      if (batchTask.current !== task) return
      batchTask.current = null
      setBatch(null)
      setBatchFailures(failed)
      const succeeded = finished - failed.length
      const label = kind === "analysis" ? "Analyzed" : "Cached stems for"
      setFeedback([task.signal.aborted ? "Cancelled." : "", label + " " + succeeded + (succeeded === 1 ? " track." : " tracks."),
        failed.length ? failed.length + " failed." : ""].filter(Boolean).join(" "))
    }
  }

  function renderFolders(branches: FolderNode[], depth = 0): ReactElement {
    return <ul aria-label={depth === 0 ? "Imported folders" : undefined}>
      {branches.map(branch => {
        const expanded = expandedFolders.has(branch.path)
        return <li key={branch.path}>
          <div className="track-library-folder-row" style={{ paddingInlineStart: Math.min(depth, 6) * 9 }}>
            {branch.children.length > 0 ? <button type="button" className="track-library-folder-toggle"
              aria-label={(expanded ? "Collapse " : "Expand ") + branch.path} aria-expanded={expanded}
              onClick={() => setExpandedFolders(previous => {
                const next = new Set(previous)
                if (expanded) next.delete(branch.path)
                else next.add(branch.path)
                return next
              })}>{expanded ? <CaretDownIcon aria-hidden="true" /> : <CaretRightIcon aria-hidden="true" />}</button>
              : <span className="track-library-folder-toggle-space" />}
            <button type="button" className="track-library-location" aria-current={folder === branch.path ? "true" : undefined}
              aria-label={"Folder " + branch.path} title={branch.path} onClick={() => browse({ kind: "folder", path: branch.path })}>
              <FolderIcon aria-hidden="true" /> <span>{branch.name}</span>
            </button>
          </div>
          {expanded && branch.children.length > 0 && renderFolders(branch.children, depth + 1)}
        </li>
      })}
    </ul>
  }

  const unavailable = status === "unavailable"
  const playlistNameForm = playlistEditor && <form className="track-library-playlist-form" key={playlistEditor.id ?? "create"}
    onSubmit={event => { event.preventDefault(); void savePlaylistName() }}>
    <label>Playlist name
      <input autoFocus type="text" maxLength={80} required value={playlistEditor.name} disabled={playlistBusy}
        onChange={event => setPlaylistEditor({ ...playlistEditor, name: event.currentTarget.value })} />
    </label>
    <div className="track-library-playlist-actions">
      <button className="quiet" type="submit" disabled={playlistBusy || !playlistEditor.name.trim()}>
        {playlistEditor.id === null ? "Create playlist" : "Save name"}
      </button>
      <button className="quiet" type="button" disabled={playlistBusy} onClick={() => setPlaylistEditor(null)}>Cancel</button>
    </div>
    {playlistEditor.id === null && selection.length > 0 && <span className="track-library-note">Includes {selection.length} selected.</span>}
  </form>
  return <div className="track-library-browser">
    <div className="track-library-tools">
      <label className="track-library-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <input type="search" placeholder="Search tracks or folders" aria-label="Search tracks"
          value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0) }} />
      </label>
      <button className="quiet track-library-filters-toggle" type="button" aria-controls="track-library-filters"
        aria-expanded={filtersOpen} data-active={matcher.count > 0} onClick={() => {
          if (!filtersOpen && !filters.length) addFilter("genre")
          setFiltersOpen(open => !open)
        }}><FunnelSimpleIcon aria-hidden="true" /> Filters{matcher.count ? " (" + matcher.count + ")" : ""}</button>
      <button type="button" className="primary" disabled={importing || unavailable} onClick={() => filesInput.current?.click()}>
        <PlusIcon aria-hidden="true" />{importing ? "Adding…" : "Add tracks"}
      </button>
      <button type="button" className="quiet" disabled={importing || unavailable} onClick={() => {
        const picker = folderInput.current
        if (!picker || !("webkitdirectory" in picker)) {
          setFeedback("This browser’s picker supports individual tracks. Choose Add tracks to select them.")
          return
        }
        picker.webkitdirectory = true
        picker.click()
      }}><FolderOpenIcon aria-hidden="true" /> Add folder</button>
      <LibraryInterchangeDialog tracks={tracks} playlists={playlists} selectedPlaylist={playlist?.id}
        disabled={unavailable || importing} decode={decodeForPreparation} />
      <input type="file" hidden multiple ref={filesInput} aria-label="Add local audio files" accept={fileTypes}
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ""
          void add(files)
        }} />
      <input type="file" hidden multiple ref={folderInput} aria-label="Add local audio folder"
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ""
          const relative = files.find(file => file.webkitRelativePath.includes("/"))?.webkitRelativePath
          void add(files, relative?.split("/")[0])
        }} />
    </div>

    <div id="track-library-filters" ref={filtersPanel} hidden={!filtersOpen}>
      <LibraryFilterBuilder rules={filters} invalid={matcher.invalid} mode={filterMode}
        onMode={mode => { setFilterMode(mode); setPage(0) }} onAdd={() => addFilter("track")}
        onClear={() => { setFilters([]); setPage(0) }}
        onRemove={id => { setFilters(items => items.filter(rule => rule.id !== id)); setPage(0) }}
        onRule={rule => { setFilters(items => items.map(item => item.id === rule.id ? rule : item)); setPage(0) }} />
    </div>

    {(feedback || notice) && <p className="track-library-note" role="status">{feedback || notice}</p>}
    <div className="track-library-body">
      <nav className="track-library-nav" aria-label="Library locations">
        <button type="button" className="track-library-location" aria-current={!folder && !playlist ? "true" : undefined}
          onClick={() => browse({ kind: "all" })}><FileAudioIcon aria-hidden="true" /> All tracks</button>
        {folders.length > 0 && <div className="track-library-nav-group track-library-folder-tree">
          <h3>Folders</h3>
          {renderFolders(folders)}
        </div>}
        <div className="track-library-nav-group">
          <div className="track-library-nav-heading">
            <h3>Playlists</h3>
            <button className="quiet track-library-icon" type="button" aria-label="New playlist" title="New playlist"
              disabled={unavailable || playlistBusy || playlistError} aria-expanded={playlistEditor?.id === null}
              onClick={() => setPlaylistEditor(current => current?.id === null ? null : { id: null, name: "" })}>
              <PlusIcon aria-hidden="true" />
            </button>
          </div>
          {playlistEditor?.id === null && playlistNameForm}
          {playlistError && <p className="track-library-note">Playlists unavailable.</p>}
          {playlists.length > 0 && <ul aria-label="Prepared playlists">
            {playlists.map(item => <li key={item.id}>
              <button type="button" className="track-library-location" aria-current={playlist?.id === item.id ? "true" : undefined}
                title={item.name} onClick={() => browse({ kind: "playlist", id: item.id })}>
                <QueueIcon aria-hidden="true" /> <span>{item.name}</span>
              </button>
            </li>)}
          </ul>}
        </div>
      </nav>

      <div className="track-library-results">
        <div className="track-library-view">
          <h3 title={folder}>{title}</h3>
          {missingGenres.length > 0 && <button type="button" className="quiet track-library-refresh-genres"
            title="Read embedded genres from existing library files" disabled={refreshingGenres || unavailable}
            onClick={() => void refreshGenres()}>{refreshingGenres ? "Reading genre tags…" : "Refresh genre tags"}</button>}
          {playlist && <div className="track-library-playlist-actions">
            <button className="quiet track-library-icon" type="button" disabled={playlistBusy}
              title="Rename playlist" aria-label={"Rename playlist " + playlist.name} aria-expanded={playlistEditor?.id === playlist.id}
              onClick={() => setPlaylistEditor(current => current?.id === playlist.id ? null : { id: playlist.id, name: playlist.name })}>
              <PencilSimpleIcon aria-hidden="true" />
            </button>
            <button className="quiet track-library-icon" type="button" disabled={playlistBusy}
              title="Delete playlist" aria-label={"Delete playlist " + playlist.name} onClick={() => {
                if (!window.confirm("Delete playlist “" + playlist.name + "”?")) return
                void editPlaylist(async () => {
                  if (!await removeTrackPlaylist(playlist.id)) throw new Error("Playlist unavailable")
                  setPlaylistEditor(current => current?.id === playlist.id ? null : current)
                  browse({ kind: "all" })
                  setFeedback("Playlist deleted.")
                }, "Could not delete this playlist.")
              }}><TrashIcon aria-hidden="true" /></button>
          </div>}
        </div>
        {referenceTrack && <div className="track-library-match-reference" role="group" aria-label="Track match reference">
          <span>Matching against <strong>{trackTitle(referenceTrack)}</strong></span>
          <button className="quiet" type="button" onClick={() => setReferenceId(null)}>Clear match</button>
        </div>}
        {playlist && playlistEditor?.id === playlist.id && playlistNameForm}
        {selection.length > 0 && <div className="track-library-selection">
          <span>{selection.length} selected</span>
          <button className="quiet" type="button" onClick={() => setChecked(new Set())}>Clear selection</button>
          {studioLocalBackendAvailable() && <>
            <button className="quiet" type="button" disabled={Boolean(batch) || readySelection.length === 0}
              onClick={() => void prepareSelection("analysis")}>Analyze selected</button>
            <button className="quiet" type="button" disabled={Boolean(batch) || readySelection.length === 0}
              onClick={() => void prepareSelection("stems")}>Prepare stems</button>
          </>}
          {readySelection.length < selection.length && <span>{selection.length - readySelection.length} need audio</span>}
          {playlists.length > 0 && !playlist && <>
            <select aria-label="Add selection to playlist" value={addTo} onChange={event => setAddTo(event.currentTarget.value)}>
              <option value="">Choose playlist</option>
              {playlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
            <button className="quiet" type="button" disabled={!addTo || playlistBusy} onClick={() => void addSelection()}>Add selected</button>
          </>}
        </div>}
        {batch && <div className="track-library-batch" role="group" aria-label="Local preparation">
          <progress aria-label="Tracks processed" value={batch.finished} max={batch.total} />
          <span role="status">{batch.stopping ? "Cancelling…" : (batch.kind === "analysis" ? "Analyzing " : "Preparing stems for ")
            + batch.title + " (" + (batch.finished + 1) + " of " + batch.total + ")"}</span>
          <button className="quiet" type="button" disabled={batch.stopping} onClick={() => {
            setBatch(progress => progress && { ...progress, stopping: true })
            batchTask.current?.abort()
          }}>Cancel batch</button>
        </div>}
        {batchFailures.length > 0 && <details className="track-library-batch-errors">
          <summary>Failed tracks ({batchFailures.length})</summary>
          <ul>{batchFailures.map(({ name, message }, index) => <li key={index}><strong>{name}</strong> · {message}</li>)}</ul>
        </details>}
        {visible.length ? <div className="track-library-table-shell">
          <table className="track-library-table" data-playlist={Boolean(playlist)} aria-label={playlist ? "Playlist tracks" : "Tracks"}>
            <thead><tr><th scope="col" className="track-library-select-col"><input ref={selectAll} type="checkbox"
              checked={visibleSelected === visible.length} onChange={toggleAllVisible} aria-label="Select all matching tracks" /></th>
              <th scope="col">{columnFilter("track")}</th><th scope="col" className="track-library-meta-col track-library-genre-col">{columnFilter("genre")}</th>
              <th scope="col" className="track-library-meta-col">{columnFilter("bpm")}</th>
              <th scope="col" className="track-library-meta-col">{columnFilter("key")}</th>
              <th scope="col" className="track-library-meta-col">{columnFilter("duration")}</th>
              <th scope="col" className="track-library-meta-col">{columnFilter("energy")}</th>
              <th scope="col" className="track-library-prep-col">Preparation</th>
              <th scope="col" className="track-library-action-col">Decks</th></tr></thead>
            <tbody>{visible.slice(first, first + pageSize).map(track => {
              const name = trackTitle(track)
              const paths = pathsById.get(track.id) ?? []
              const path = folder ? paths.find(item => item.startsWith(folder + "/")) : paths[0]
              const bpm = typeof track.bpm === "number" ? track.bpm.toFixed(1) : ""
              const genre = track.genres?.join(", ") || ""
              const length = typeof track.duration === "number" ? formatTime(track.duration) : ""
              const energy = track.matchEvidence?.energy
              const energyText = energy ? energy.rating + "/10" : ""
              const energyHint = energy ? energy.label + " energy, estimated from level, activity, and dynamics." : "No measured energy yet."
              const position = playlistOrder.get(track.id) ?? 0
              const description = [track.artist, path || (track.title ? track.fileName : "")].filter(Boolean).join(" · ")
              const analysis = track.analysisStatus
              const cueCount = track.cueCount ?? 0
              const preparation = analysis === "analyzed" ? "Analyzed" : analysis === "partial" ? "Partial analysis"
                : track.prepared && analysis === undefined ? "Reading prep…" : "Not analyzed"
              const isReference = referenceTrack?.id === track.id
              const match = referenceTrack && !isReference ? compareTrackCompatibility(referenceTrack, track) : null
              const matchLabel = match && (match.score === null ? matchLevelLabels.limited
                : `${Math.round(match.score)} · ${matchLevelLabels[match.level]}`)
              return <tr key={track.id} data-selected={checked.has(track.id)} data-match={match?.level} data-reference={isReference}>
                <td className="track-library-select-col"><input type="checkbox" checked={checked.has(track.id)}
                  aria-label={"Select " + name} onChange={() => toggleTrack(track.id)} />
                  {playlist && <span className="track-library-order" aria-label={"Playlist position " + (position + 1)}>{position + 1}</span>}
                </td>
                <td><div className="track-library-item">
                  <div className="track-library-item-title"><strong title={track.fileName}>{name}</strong>
                    {track.needsAudio && <span className="track-library-prepared" title="Add the matching original audio file to relink this library entry.">Audio needed</span>}
                  </div>
                  {description && <span title={description}>{description}</span>}
                  {isReference && <span className="track-library-match-label">Match reference</span>}
                  {matchLabel && <span className="track-library-match-label" title={match?.detail}>{matchLabel}</span>}
                  <span className="track-library-mobile-meta" title={genre || undefined}>
                    {[genre, bpm && bpm + " BPM", track.key, length, energyText && "Energy " + energyText].filter(Boolean).join(" · ")}
                  </span>
                </div></td>
                <td className="track-library-meta-col track-library-genre-col" title={genre || undefined}>{genre || "–"}</td>
                <td className="track-library-meta-col">{bpm || "–"}</td><td className="track-library-meta-col">{track.key || "–"}</td>
                <td className="track-library-meta-col time">{length || "–"}</td>
                <td className="track-library-meta-col" title={energyHint}>{energyText || "–"}</td>
                <td className="track-library-prep-col"><div className="track-library-prep">
                  <span data-analysis={analysis}>{preparation}</span>
                  <span>{cueCount} {cueCount === 1 ? "cue" : "cues"}</span>
                  <select value={track.reviewStatus ?? ""} aria-label={"Review status for " + name}
                    disabled={reviewPending.has(track.id) || track.needsAudio}
                    onChange={event => void changeReview(track.id, event.currentTarget.value)}>
                    <option value="">Needs review</option><option value="reviewed">Reviewed</option>
                    <option value="approved">Approved</option>
                  </select>
                </div></td>
                <td><div className="track-library-decks">
                  {decks.map(deck => <button key={deck} type="button" className="quiet" data-deck={deck}
                    aria-label={"Load " + track.name + " on Deck " + deck}
                    disabled={busyDecks[deck] || loaded[deck] === track.id || track.needsAudio}
                    onClick={() => void load(deck, track)}>{loaded[deck] === track.id ? "On " + deck : "Load " + deck}</button>)}
                  <button className="quiet track-library-icon track-library-match-button" type="button"
                    title={"Match other tracks against " + name} aria-label={"Match tracks against " + name} aria-pressed={isReference}
                    onClick={() => setReferenceId(current => current === track.id ? null : track.id)}>
                    <ArrowsLeftRightIcon aria-hidden="true" />
                  </button>
                  {playlist ? <div className="track-library-playlist-actions">
                    {([-1, 1] as const).map(step => {
                      const direction = step < 0 ? "up" : "down"
                      return <button key={step} type="button" className="quiet track-library-icon"
                        aria-label={"Move " + name + " " + direction + " in playlist"} title={"Move " + direction}
                        disabled={playlistBusy || position + step < 0 || position + step >= playlist.trackIds.length}
                        onClick={() => void editPlaylist(async () => {
                          const updated = await moveTrackInPlaylist(playlist.id, track.id, position + step)
                          if (!updated) throw new Error("Playlist unavailable")
                          setPlaylists(items => items.map(item => item.id === updated.id ? updated : item))
                        }, "Could not reorder this playlist.")}>{step < 0 ? <ArrowUpIcon /> : <ArrowDownIcon />}</button>
                    })}
                    <button type="button" className="quiet track-library-icon" aria-label={"Remove " + name + " from playlist"}
                      title="Remove from playlist" disabled={playlistBusy}
                      onClick={() => void editPlaylist(async () => {
                        const updated = await removeTrackFromPlaylist(playlist.id, track.id)
                        if (!updated) throw new Error("Playlist unavailable")
                        setPlaylists(items => items.map(item => item.id === updated.id ? updated : item))
                      }, "Could not remove this track from the playlist.")}><XIcon aria-hidden="true" /></button>
                  </div> : <button type="button" className="quiet track-library-icon" title="Remove library copy"
                    aria-label={"Remove " + track.name + " from the library"} disabled={removing !== null}
                    onClick={() => void remove(track)}><TrashIcon aria-hidden="true" /></button>}
                </div></td>
              </tr>
            })}</tbody>
          </table>
        </div> : <p className="track-library-empty">
          {status === "loading" ? "Reading the local library…" : unavailable ? "Library storage is unavailable."
            : matcher.count || query.trim() ? "No tracks match the current search and filters." : playlist ? "Select tracks in the library to add them to this playlist."
              : folder ? "No tracks in this folder." : "Add audio files or a folder to get started."}
        </p>}
        {visible.length > 0 && <div className="track-library-footer">
          <span>{lastPage > 0 ? (first + 1) + "–" + Math.min(first + pageSize, visible.length) + " of " : ""}{visible.length} {visible.length === 1 ? "track" : "tracks"}</span>
          {lastPage > 0 && <>
            <button className="quiet" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
            <button className="quiet" type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</button>
          </>}
        </div>}
      </div>
    </div>
  </div>
}
