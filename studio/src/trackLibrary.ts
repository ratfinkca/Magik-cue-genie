import type { Sidecar } from "./cues"
import { LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE, LIBRARY_PREP_STORE, requestFromStore, studioTransaction, TRACK_PLAYLIST_STORE } from "./deckSession"
import { formatKey } from "./key"
import { readTrackMatchEvidence } from "./trackMatchEvidence"
import type { TrackMatchEvidence } from "./trackMatchEvidence"
import { readLibraryTrackMetadata } from "./trackMetadata"
import { publishTrackPlaylists, removeTrackFromEveryPlaylist } from "./trackPlaylist"

export interface LibraryTrack {
  id: string
  name: string
  fileName: string
  size: number
  addedAt: number
  prepared: boolean
  analysisStatus?: LibraryAnalysisStatus
  cueCount?: number
  matchEvidence?: TrackMatchEvidence
  reviewStatus?: LibraryReviewStatus
  needsAudio?: true
  artist?: string
  title?: string
  duration?: number
  bpm?: number
  key?: string
  genres?: string[]
  relativePath?: string
  relativePaths?: string[]
}

export type LibraryAnalysisStatus = "none" | "partial" | "analyzed"
export type LibraryReviewStatus = "reviewed" | "approved"

export const MAX_LIBRARY_FILE_BYTES = 256 * 1024 * 1024
export const LIBRARY_FILE_SIZE_MESSAGE = "Choose a nonempty audio file up to 256 MiB."
const libraryStores = [LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE, LIBRARY_PREP_STORE]
type PrepStatus = "saving" | "saved" | "error"
type PrepListener = (sidecar: Sidecar, origin?: object, status?: PrepStatus) => void
type PrepUpdate = { sidecar: Sidecar; origin?: object; epoch?: object }
const indexListeners = new Set<() => void>()
const prepListeners = new Map<string, Set<PrepListener>>()
const prepWriteQueue = new Map<string, Promise<void>>()
const pendingPrep = new Map<string, PrepUpdate>()
const libraryEpoch = new Map<string, object>()

export function subscribeLibrary(onChange: () => void) {
  indexListeners.add(onChange)
  return () => { indexListeners.delete(onChange) }
}

export function publishLibrary() {
  for (const listener of indexListeners) listener()
}

export async function finishTrackPrepWrites() {
  await Promise.all(prepWriteQueue.values())
}

export function publishRestoredTrackPrep(libraryId: string, sidecar: Sidecar) {
  if (currentPrep(libraryId)) return
  for (const listener of prepListeners.get(libraryId) ?? []) listener(sidecar, undefined, "saved")
}

export async function identifyLibraryTrack(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new DOMException("Track fingerprinting requires a secure browser origin.", "NotSupportedError")
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")
}

function libraryEntry(id: string): Promise<LibraryTrack | undefined> {
  return requestFromStore("readonly", tx => tx.objectStore(LIBRARY_INDEX_STORE).get(id), LIBRARY_INDEX_STORE)
}

export async function readLibraryTracks(): Promise<LibraryTrack[]> {
  const entries: LibraryTrack[] = await requestFromStore("readonly", tx => tx.objectStore(LIBRARY_INDEX_STORE).getAll(), LIBRARY_INDEX_STORE)
  return entries.sort((first, second) => second.addedAt - first.addedAt || first.name.localeCompare(second.name))
}

const audioExtension = /\.(?:aac|ac3|aif|aifc|aiff|alac|ape|au|caf|flac|m4a|m4b|mp2|mp3|mp4|oga|ogg|opus|wav|wave|webm|wma|wv)$/i
const playlistExtension = /\.(?:cue|m3u|m3u8|pls)$/i

export function isAudioFile(file: File) {
  return !playlistExtension.test(file.name) && (file.type.toLowerCase().startsWith("audio/") || audioExtension.test(file.name))
}

function folderRelativePath(file: File): string | undefined {
  const path = file.webkitRelativePath
  if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z]:/i.test(path)) return undefined
  const parts = path.split("/")
  if (parts.length < 2 || parts.at(-1) !== file.name || parts.some(part => !part || part === "." || part === "..")) return undefined
  return path
}

function addRelativePath(id: string, path: string) {
  return studioTransaction(LIBRARY_INDEX_STORE, "readwrite", tx => {
    const store = tx.objectStore(LIBRARY_INDEX_STORE)
    const request = store.get(id)
    let entry: LibraryTrack | undefined
    let pathsUpdated = false
    request.onsuccess = () => {
      entry = request.result
      if (!entry) return
      const paths = entry.relativePaths ?? (entry.relativePath ? [entry.relativePath] : [])
      if (paths.includes(path)) return
      entry = { ...entry, relativePath: entry.relativePath ?? path, relativePaths: [...paths, path] }
      pathsUpdated = true
      store.put(entry)
    }
    return () => ({ entry, pathsUpdated })
  })
}

/** Persist only encoded media. A repeated SHA-256 fingerprint keeps the first copy and any preparation. */
export async function addLibraryFile(file: File, fingerprint?: string, announce = true) {
  if (!file.size || file.size > MAX_LIBRARY_FILE_BYTES) throw new RangeError(LIBRARY_FILE_SIZE_MESSAGE)
  const id = fingerprint ?? await identifyLibraryTrack(await file.arrayBuffer())
  const relativePath = folderRelativePath(file)
  async function rememberExisting(entry: LibraryTrack) {
    if (entry.needsAudio) {
      const restored = await studioTransaction([LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE], "readwrite", tx => {
        const index = tx.objectStore(LIBRARY_INDEX_STORE)
        const lookup = index.get(id)
        let track: LibraryTrack | undefined
        lookup.onsuccess = () => {
          const existing: LibraryTrack | undefined = lookup.result
          if (!existing?.needsAudio) return
          const paths = existing.relativePaths ?? (existing.relativePath ? [existing.relativePath] : [])
          track = { ...existing, needsAudio: undefined, ...(relativePath ? {
            relativePath: existing.relativePath ?? relativePath, relativePaths: [...new Set([...paths, relativePath])],
          } : {}) }
          tx.objectStore(LIBRARY_MEDIA_STORE).put({ id, audio: file, lastModified: file.lastModified })
          index.put(track)
        }
        return () => track
      })
      if (restored) {
        if (announce) publishLibrary()
        return { entry: restored, added: false, pathsUpdated: Boolean(relativePath), relinked: true }
      }
      const latest = await libraryEntry(id)
      if (!latest) return null
      entry = latest
    }
    if (!relativePath || entry.relativePath === relativePath || entry.relativePaths?.includes(relativePath)) {
      return { entry, added: false, pathsUpdated: false, relinked: false }
    }
    const updated = await addRelativePath(id, relativePath)
    if (!updated.entry) return null
    if (announce && updated.pathsUpdated) publishLibrary()
    return { entry: updated.entry, added: false, pathsUpdated: updated.pathsUpdated, relinked: false }
  }
  const known = await libraryEntry(id)
  if (known) {
    const existing = await rememberExisting(known)
    if (existing) return existing
  }
  const metadata = await readLibraryTrackMetadata(file)
  const entry: LibraryTrack = {
    id, fileName: file.name, size: file.size, addedAt: Date.now(), prepared: false,
    name: file.name.replace(/\.[^.]+$/, "") || file.name,
    artist: metadata.artist, title: metadata.title, duration: metadata.duration,
    bpm: metadata.bpm ?? undefined, key: metadata.key ? formatKey(metadata.key, "standard") : undefined,
    genres: metadata.genres,
    ...(relativePath ? { relativePath, relativePaths: [relativePath] } : {}),
  }
  try {
    await requestFromStore("readwrite", tx => {
      tx.objectStore(LIBRARY_MEDIA_STORE).put({ id, audio: file, lastModified: file.lastModified })
      return tx.objectStore(LIBRARY_INDEX_STORE).add(entry)
    }, [LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE])
  } catch (cause) {
    // Concurrent imports of the same bytes can race after the first lookup.
    if (cause instanceof DOMException && cause.name === "ConstraintError") {
      const existing = await libraryEntry(id)
      if (existing) {
        const remembered = await rememberExisting(existing)
        if (remembered) return remembered
      }
    }
    throw cause
  }
  libraryEpoch.set(id, {})
  if (announce) publishLibrary()
  return { entry, added: true, pathsUpdated: false, relinked: false }
}

export async function addLibraryFiles(files: Iterable<File>) {
  const result = { added: 0, existing: 0, relinked: 0, failed: 0, skipped: 0 }
  let pathsUpdated = false
  let lastError: unknown
  for (const file of files) {
    if (!isAudioFile(file)) { result.skipped++; continue }
    try {
      const entry = await addLibraryFile(file, undefined, false)
      if (entry.added) result.added++
      else if (entry.relinked) result.relinked++
      else result.existing++
      pathsUpdated ||= entry.pathsUpdated
    } catch (cause) { result.failed++; lastError = cause }
  }
  if (result.added || result.relinked || pathsUpdated) publishLibrary()
  return { ...result, lastError }
}

export function openLibraryFile(id: string): Promise<{ entry: LibraryTrack; file: File } | null> {
  return studioTransaction([LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE], "readonly", tx => {
    const entry = tx.objectStore(LIBRARY_INDEX_STORE).get(id)
    const media = tx.objectStore(LIBRARY_MEDIA_STORE).get(id)
    return () => {
      const record = media.result
      if (!entry.result || !(record?.audio instanceof Blob)) return null
      return { entry: entry.result, file: new File([record.audio], entry.result.fileName, {
        type: record.audio.type, lastModified: record.lastModified,
      }) }
    }
  })
}

/** Backfill legacy entries by reading tags from their cached encoded files. */
export async function refreshLibraryGenres(ids: readonly string[]) {
  const result = { tagged: 0, untagged: 0, unavailable: 0 }
  for (const id of new Set(ids)) {
    const epoch = libraryEpoch.get(id)
    try {
      const cached = await openLibraryFile(id)
      if (!cached) { result.unavailable++; continue }
      if (cached.entry.genres !== undefined) continue
      const { genres } = await readLibraryTrackMetadata(cached.file)
      const updated = await studioTransaction(LIBRARY_INDEX_STORE, "readwrite", tx => {
        const store = tx.objectStore(LIBRARY_INDEX_STORE)
        const request = store.get(id)
        let saved = false
        request.onsuccess = () => {
          const entry: LibraryTrack | undefined = request.result
          if (!entry || entry.genres !== undefined || libraryEpoch.get(id) !== epoch) return
          store.put({ ...entry, genres })
          saved = true
        }
        return () => saved
      })
      if (updated) result[genres.length ? "tagged" : "untagged"]++
    } catch {
      result.unavailable++
    }
  }
  if (result.tagged || result.untagged) publishLibrary()
  return result
}

export async function deleteLibraryTrack(id: string) {
  libraryEpoch.set(id, {})
  await studioTransaction([...libraryStores, TRACK_PLAYLIST_STORE], "readwrite", tx => {
    for (const store of libraryStores) tx.objectStore(store).delete(id)
    removeTrackFromEveryPlaylist(tx, id)
    return () => undefined
  })
  publishLibrary()
  publishTrackPlaylists()
}

function currentPrep(libraryId: string) {
  const update = pendingPrep.get(libraryId)
  return update && update.epoch === libraryEpoch.get(libraryId) ? update : undefined
}

export async function readTrackPrep(libraryId: string): Promise<Sidecar | null> {
  const pending = currentPrep(libraryId)
  if (pending) return pending.sidecar
  const epoch = libraryEpoch.get(libraryId)
  const record = await requestFromStore("readonly", tx => tx.objectStore(LIBRARY_PREP_STORE).get(libraryId), LIBRARY_PREP_STORE)
  return currentPrep(libraryId)?.sidecar ?? (epoch === libraryEpoch.get(libraryId) ? record?.sidecar ?? null : null)
}

export function subscribeTrackPrep(libraryId: string, listener: PrepListener) {
  let group = prepListeners.get(libraryId)
  if (!group) prepListeners.set(libraryId, group = new Set())
  group.add(listener)
  const pending = currentPrep(libraryId)
  if (pending) listener(pending.sidecar, pending.origin, "saving")
  return () => {
    group.delete(listener)
    if (!group.size) prepListeners.delete(libraryId)
  }
}

function positive(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined }

export function summarizeLibraryPrep(sidecar: Sidecar): {
  analysisStatus: LibraryAnalysisStatus; cueCount: number; matchEvidence: TrackMatchEvidence
} {
  const analysis = sidecar.analysis
  const stages = ["studio_base", "studio_tempo", "studio_beatgrid", "studio_cues"].map(key => {
    const stage = analysis[key]
    if (stage && typeof stage === "object" && "status" in stage && typeof stage.status === "string") {
      return stage.status
    }
    return null
  })
  const analysisStatus = stages.some(stage => stage === "partial" || stage === "error") ? "partial"
    : stages.some(Boolean) || analysis.energy_summary ? "analyzed" : "none"
  return { analysisStatus, cueCount: sidecar.cues.length, matchEvidence: readTrackMatchEvidence(sidecar) }
}

/** Fill in new index summaries using local preparation already saved for old rows. */
export async function backfillLibraryPrepSummaries(ids: readonly string[]) {
  const touched = await studioTransaction([LIBRARY_INDEX_STORE, LIBRARY_PREP_STORE], "readwrite", tx => {
    const index = tx.objectStore(LIBRARY_INDEX_STORE)
    const preps = tx.objectStore(LIBRARY_PREP_STORE)
    let changed = false
    for (const id of ids) {
      const request = index.get(id)
      request.onsuccess = () => {
        const entry: LibraryTrack | undefined = request.result
        if (!entry?.prepared || (entry.analysisStatus !== undefined && entry.cueCount !== undefined && entry.matchEvidence)) return
        const previous = preps.get(id)
        previous.onsuccess = () => {
          const sidecar = previous.result?.sidecar as Sidecar | undefined
          const summary = sidecar ? summarizeLibraryPrep(sidecar) : { analysisStatus: "none", cueCount: 0, matchEvidence: { version: 1 } }
          index.put({ ...entry, ...summary })
          changed = true
        }
      }
    }
    return () => changed
  })
  if (touched) publishLibrary()
}

export async function setLibraryReviewStatus(id: string, reviewStatus: LibraryReviewStatus | undefined) {
  await prepWriteQueue.get(id)
  const saved = await studioTransaction(LIBRARY_INDEX_STORE, "readwrite", tx => {
    const index = tx.objectStore(LIBRARY_INDEX_STORE)
    const request = index.get(id)
    let found = false
    request.onsuccess = () => {
      const entry: LibraryTrack | undefined = request.result
      if (!entry) return
      found = true
      if (entry.reviewStatus === reviewStatus) return
      const next = { ...entry, reviewStatus }
      if (!reviewStatus) delete next.reviewStatus
      index.put(next)
    }
    return () => found
  })
  if (!saved) throw new DOMException("This track is no longer in the local library.", "NotFoundError")
  publishLibrary()
}

function reviewEvidence(sidecar: Sidecar | undefined) {
  if (!sidecar) return null
  const { analysis, cues } = sidecar
  const times = (grid: unknown) => grid && typeof grid === "object" && "beat_times_seconds" in grid
    ? grid.beat_times_seconds : undefined
  return [cues, analysis.estimated_bpm, analysis.estimated_key, times(analysis.studio_beatgrid), times(analysis.studio_model_grid),
    analysis.studio_manual_grid, analysis.studio_rekordbox_tempo]
}

function commitTrackPrep(libraryId: string, { sidecar, epoch }: PrepUpdate, onlyIfMissing = false) {
  const stillOwned = () => epoch === libraryEpoch.get(libraryId)
  const summary = summarizeLibraryPrep(sidecar)
  return studioTransaction([LIBRARY_INDEX_STORE, LIBRARY_PREP_STORE], "readwrite", tx => {
    const index = tx.objectStore(LIBRARY_INDEX_STORE)
    const preps = tx.objectStore(LIBRARY_PREP_STORE)
    const request = index.get(libraryId)
    let found = false
    let indexChanged = false
    let saved = false
    request.onsuccess = () => {
      const entry: LibraryTrack | undefined = request.result
      if (!entry || !stillOwned()) return
      found = true
      function save(previous?: Sidecar) {
        if (!entry || !stillOwned() || (onlyIfMissing && (previous || currentPrep(libraryId)))) return
        try {
          preps.put({ id: libraryId, sidecar })
          saved = true
          const bpm = positive(sidecar.analysis.estimated_bpm) ?? entry.bpm
          const duration = positive(sidecar.analysis.duration_seconds) ?? entry.duration
          const analyzedKey = sidecar.analysis.estimated_key
          const key = (typeof analyzedKey === "string" && analyzedKey.trim()) || entry.key
          const reviewChanged = Boolean(entry.reviewStatus && JSON.stringify(reviewEvidence(previous)) !== JSON.stringify(reviewEvidence(sidecar)))
          indexChanged = !entry.prepared || entry.bpm !== bpm || entry.duration !== duration || entry.key !== key
            || entry.analysisStatus !== summary.analysisStatus || entry.cueCount !== summary.cueCount || reviewChanged
            || JSON.stringify(entry.matchEvidence) !== JSON.stringify(summary.matchEvidence)
          if (indexChanged) {
            const next = { ...entry, ...summary, prepared: true, bpm, key, duration }
            if (reviewChanged) delete next.reviewStatus
            index.put(next)
          }
        } catch { tx.abort() }
      }
      if (entry.reviewStatus || onlyIfMissing) {
        const previous = preps.get(libraryId)
        previous.onsuccess = () => save(previous.result?.sidecar)
      } else save()
    }
    return () => {
      if (!found || !stillOwned()) throw new DOMException("This track is no longer in the local library.", "NotFoundError")
      return { saved, indexChanged }
    }
  })
}

/** Keep preparation already present even when another editor saves during an import. */
export async function importMissingTrackPrep(libraryId: string, sidecar: Sidecar): Promise<boolean> {
  if (currentPrep(libraryId)) return false
  const result = await commitTrackPrep(libraryId, { sidecar, epoch: libraryEpoch.get(libraryId) }, true)
  if (result.indexChanged) publishLibrary()
  if (result.saved) publishRestoredTrackPrep(libraryId, sidecar)
  return result.saved
}

/** Synchronize same-item decks immediately, then serialize durable saves in edit order. */
export function writeTrackPrep(libraryId: string, sidecar: Sidecar, origin?: object): Promise<void> {
  const update = { sidecar, origin, epoch: libraryEpoch.get(libraryId) }
  pendingPrep.set(libraryId, update)
  const notify = (status: PrepStatus) => {
    for (const listener of prepListeners.get(libraryId) ?? []) listener(sidecar, origin, status)
  }
  const write = (prepWriteQueue.get(libraryId) ?? Promise.resolve()).then(async () => {
    if ((await commitTrackPrep(libraryId, update)).indexChanged) publishLibrary()
  })
  const settle = (status: PrepStatus) => {
    if (prepWriteQueue.get(libraryId) !== tail) return
    prepWriteQueue.delete(libraryId)
    pendingPrep.delete(libraryId)
    notify(status)
  }
  const tail = write.then(() => settle("saved"), () => settle("error"))
  prepWriteQueue.set(libraryId, tail)
  notify("saving")
  return write
}
