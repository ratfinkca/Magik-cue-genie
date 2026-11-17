import { readSidecar } from "./cues"
import type { Sidecar } from "./cues"
import { LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE, LIBRARY_PREP_STORE, studioTransaction, TRACK_PLAYLIST_STORE } from "./deckSession"
import { finishTrackPrepWrites, MAX_LIBRARY_FILE_BYTES, publishLibrary, publishRestoredTrackPrep, summarizeLibraryPrep } from "./trackLibrary"
import type { LibraryTrack } from "./trackLibrary"
import { publishTrackPlaylists } from "./trackPlaylist"
import type { TrackPlaylist } from "./trackPlaylist"
import { MIDI_MAPPING_PREFERENCE_KEY, validateMidiPreferences } from "./midiPreferences"

const backupFormat = "magik-cue-studio-backup"
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024
const trackId = /^[a-f0-9]{64}$/
const stores = [LIBRARY_INDEX_STORE, LIBRARY_PREP_STORE, TRACK_PLAYLIST_STORE]
const textPreferences: Record<string, string[]> = {
  "magik.keyNotation": ["standard", "camelot", "open"],
  "magik.studio.quantize.v1": ["off", "beat", "half", "quarter", "eighth"],
  "magik.studio.hotCueMode": ["instant", "release", "hold"],
  "magik.studio.dockMode": ["library", "cues"],
  "magik.studio.syncMode": ["one-shot", "follow"],
  "magik.studio.pitchRange": ["8", "16", "wide"],
  "magik.auditionBehavior": ["continue", "pause", "loop"],
  "magik.leadInPlacement": ["insert", "append"],
}
const objectPreferences = ["magik.transitionMixer", "magik.twoDeckEq", "magik.studio.waveforms.v1", "magik.studio.preparation.v1",
  MIDI_MAPPING_PREFERENCE_KEY]

type PortableTrack = Omit<LibraryTrack, "needsAudio">
type PrepRecord = { id: string; sidecar: Sidecar }
export type StudioBackupDocument = {
  format: typeof backupFormat
  schema_version: 1
  exported_at: string
  tracks: Array<{ track: PortableTrack; preparation?: Sidecar }>
  playlists: TrackPlaylist[]
  preferences: Record<string, string | Record<string, unknown>>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit = 1024): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= limit
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function relativePath(value: unknown): value is string {
  if (!text(value) || /[\\\u0000-\u001f\u007f]/.test(value) || /^[a-z]:/i.test(value)) return false
  const parts = value.split("/")
  return parts.length > 1 && parts.every(part => part && part !== "." && part !== "..")
}

function portableTrack(value: unknown): PortableTrack {
  if (!record(value) || typeof value.id !== "string" || !trackId.test(value.id) || !text(value.name)
    || !text(value.fileName) || /[\\/\u0000-\u001f\u007f]/.test(value.fileName)
    || !number(value.size) || !Number.isSafeInteger(value.size) || value.size > MAX_LIBRARY_FILE_BYTES
    || !number(value.addedAt)) {
    throw new Error("The backup contains an invalid track reference.")
  }
  const paths = new Set((Array.isArray(value.relativePaths) ? value.relativePaths : []).filter(relativePath))
  if (relativePath(value.relativePath)) paths.add(value.relativePath)
  return {
    id: value.id, name: value.name, fileName: value.fileName, size: value.size, addedAt: value.addedAt, prepared: false,
    ...(text(value.artist) && { artist: value.artist }), ...(text(value.title) && { title: value.title }),
    ...(number(value.duration) && { duration: value.duration }), ...(number(value.bpm) && { bpm: value.bpm }),
    ...(text(value.key) && { key: value.key }), ...(Array.isArray(value.genres) && { genres: value.genres.filter(item => text(item)) }),
    ...(paths.size > 0 && { relativePath: paths.values().next().value, relativePaths: [...paths] }),
    ...((value.reviewStatus === "reviewed" || value.reviewStatus === "approved") && { reviewStatus: value.reviewStatus }),
  }
}

function readPreparation(value: unknown, track: PortableTrack): Sidecar {
  if (!record(value) || !text(value.source_file)) throw new Error("A track in the backup has invalid saved preparation.")
  const reported = record(value.analysis) ? value.analysis.duration_seconds : null
  const duration = number(reported) ? reported : track.duration ?? 30 * 60
  return { ...readSidecar(JSON.stringify(value), value.source_file, duration), source_file: track.fileName }
}

function portablePlaylist(value: unknown, tracks: Set<string>): TrackPlaylist {
  if (!record(value) || !text(value.id, 128) || !text(value.name, 128) || !number(value.updatedAt)
    || !Array.isArray(value.trackIds) || value.trackIds.some(id => typeof id !== "string" || !tracks.has(id))) {
    throw new Error("A playlist in the backup refers to an unknown track or has invalid metadata.")
  }
  return { id: value.id, name: value.name, updatedAt: value.updatedAt, trackIds: [...new Set<string>(value.trackIds)] }
}

function portablePreferences(input: Record<string, unknown>): StudioBackupDocument["preferences"] {
  const preferences: StudioBackupDocument["preferences"] = {}
  for (const [key, options] of Object.entries(textPreferences)) {
    if (typeof input[key] === "string" && options.includes(input[key])) preferences[key] = input[key]
  }
  for (const key of objectPreferences) {
    if (key === MIDI_MAPPING_PREFERENCE_KEY) {
      const midi = validateMidiPreferences(input[key])
      if (midi) preferences[key] = midi
    } else if (record(input[key])) preferences[key] = input[key]
  }
  return preferences
}

function readPreferences() {
  const saved: Record<string, unknown> = {}
  for (const key of [...Object.keys(textPreferences), ...objectPreferences]) {
    try {
      const value = localStorage.getItem(key)
      if (value !== null) saved[key] = objectPreferences.includes(key) ? JSON.parse(value) : value
    } catch { /* Optional preferences may be unavailable. */ }
  }
  return portablePreferences(saved)
}

export function parseStudioBackup(source: string): StudioBackupDocument {
  let value: unknown
  try { value = JSON.parse(source) }
  catch { throw new Error("This backup file is not valid JSON.") }
  if (!record(value) || value.format !== backupFormat || value.schema_version !== 1
    || typeof value.exported_at !== "string" || !Number.isFinite(Date.parse(value.exported_at))
    || !Array.isArray(value.tracks) || !Array.isArray(value.playlists) || !record(value.preferences)) {
    throw new Error("Choose a Cue Studio version 1 backup JSON file.")
  }
  const ids = new Set<string>()
  const tracks = value.tracks.map(item => {
    if (!record(item)) throw new Error("The backup contains an invalid track reference.")
    const track = portableTrack(item.track)
    if (ids.has(track.id)) throw new Error("The backup contains a duplicate track fingerprint.")
    ids.add(track.id)
    if (item.preparation === undefined) return { track }
    const preparation = readPreparation(item.preparation, track)
    return { track: { ...track, prepared: true, ...summarizeLibraryPrep(preparation) }, preparation }
  })
  const playlists = value.playlists.map(item => portablePlaylist(item, ids))
  if (new Set(playlists.map(item => item.id)).size !== playlists.length) throw new Error("The backup contains a duplicate playlist ID.")
  return { format: backupFormat, schema_version: 1, exported_at: value.exported_at, tracks, playlists,
    preferences: portablePreferences(value.preferences) }
}

export async function readStudioBackup(): Promise<StudioBackupDocument> {
  await finishTrackPrepWrites()
  return studioTransaction(stores, "readonly", tx => {
    const index: IDBRequest<LibraryTrack[]> = tx.objectStore(LIBRARY_INDEX_STORE).getAll()
    const prep: IDBRequest<PrepRecord[]> = tx.objectStore(LIBRARY_PREP_STORE).getAll()
    const playlists: IDBRequest<TrackPlaylist[]> = tx.objectStore(TRACK_PLAYLIST_STORE).getAll()
    return () => {
      const preparations = new Map(prep.result.map(item => [item.id, item.sidecar]))
      const tracks = index.result.map(item => {
        const track = portableTrack(item)
        const preparation = preparations.get(track.id)
        return preparation ? { track: { ...track, prepared: true, ...summarizeLibraryPrep(preparation) }, preparation } : { track }
      })
      return {
        format: backupFormat, schema_version: 1, exported_at: new Date().toISOString(), tracks,
        playlists: playlists.result, preferences: readPreferences(),
      }
    }
  })
}

type RestoreOptions = { replaceMatched: boolean; restorePreferences: boolean }

export async function restoreStudioBackup(backup: StudioBackupDocument, options: RestoreOptions) {
  await finishTrackPrepWrites()
  const updated = await studioTransaction([...stores, LIBRARY_MEDIA_STORE], "readwrite", tx => {
    const index = tx.objectStore(LIBRARY_INDEX_STORE)
    const prep = tx.objectStore(LIBRARY_PREP_STORE)
    const playlists = tx.objectStore(TRACK_PLAYLIST_STORE)
    const tracks: IDBRequest<LibraryTrack[]> = index.getAll()
    const existingPrep: IDBRequest<IDBValidKey[]> = prep.getAllKeys()
    const existingPlaylists: IDBRequest<IDBValidKey[]> = playlists.getAllKeys()
    const media: IDBRequest<IDBValidKey[]> = tx.objectStore(LIBRARY_MEDIA_STORE).getAllKeys()
    const stats = { tracksAdded: 0, needsAudio: 0, preparationRestored: 0, preparationKept: 0, playlistsRestored: 0, playlistsKept: 0 }
    const preparations: PrepRecord[] = []
    const pending: IDBRequest[] = [tracks, existingPrep, existingPlaylists, media]
    let merged = false
    function merge() {
      if (merged || pending.some(request => request.readyState !== "done")) return
      merged = true
      const oldTracks = new Map(tracks.result.map(track => [track.id, track]))
      const prepared = new Set(existingPrep.result)
      const knownPlaylists = new Set(existingPlaylists.result)
      const linked = new Set(media.result)
      for (const { track, preparation } of backup.tracks) {
        const existing = oldTracks.get(track.id)
        const needsAudio = !linked.has(track.id)
        if (needsAudio) stats.needsAudio++
        if (!existing) stats.tracksAdded++
        const restorePrep = preparation && (options.replaceMatched || !prepared.has(track.id))
        if (restorePrep) {
          const sidecar = { ...preparation, source_file: existing?.fileName ?? track.fileName }
          const entry: PrepRecord = { id: track.id, sidecar }
          prep.put(entry)
          preparations.push(entry)
          stats.preparationRestored++
        } else if (preparation) stats.preparationKept++

        if (!existing || restorePrep || Boolean(existing.needsAudio) !== needsAudio) {
          const reviewStatus = restorePrep || !existing ? track.reviewStatus : existing.reviewStatus
          const analysis = restorePrep ? preparation.analysis : {}
          const status = restorePrep ? summarizeLibraryPrep(preparation) : {}
          index.put({ ...track, ...existing, ...status, needsAudio: needsAudio ? true : undefined, reviewStatus,
            prepared: Boolean(restorePrep || prepared.has(track.id)),
            ...(number(analysis.estimated_bpm) && { bpm: analysis.estimated_bpm }),
            ...(number(analysis.duration_seconds) && { duration: analysis.duration_seconds }),
            ...(text(analysis.estimated_key) && { key: analysis.estimated_key }),
          })
        }
      }
      for (const playlist of backup.playlists) {
        if (knownPlaylists.has(playlist.id) && !options.replaceMatched) stats.playlistsKept++
        else { playlists.put(playlist); stats.playlistsRestored++ }
      }
    }
    for (const request of pending) request.onsuccess = () => {
      try { merge() } catch { tx.abort() }
    }
    return () => ({ stats, preparations })
  })

  let preferencesRestored = 0
  let preferencesFailed = 0
  if (options.restorePreferences) {
    for (const [key, value] of Object.entries(backup.preferences)) {
      try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); preferencesRestored++ }
      catch { preferencesFailed++ }
    }
  }
  publishLibrary()
  publishTrackPlaylists()
  for (const { id, sidecar } of updated.preparations) publishRestoredTrackPrep(id, sidecar)
  return { ...updated.stats, preferencesRestored, preferencesFailed }
}
