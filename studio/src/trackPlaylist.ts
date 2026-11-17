import { LIBRARY_INDEX_STORE, makeSavedRecordKey, requestFromStore, studioTransaction, TRACK_PLAYLIST_STORE } from "./deckSession"

export interface TrackPlaylist {
  id: string
  name: string
  trackIds: string[]
  updatedAt: number
}

const listeners = new Set<() => void>()

export function subscribeTrackPlaylists(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function publishTrackPlaylists() {
  for (const listener of listeners) listener()
}

export async function readTrackPlaylists(): Promise<TrackPlaylist[]> {
  const entries: TrackPlaylist[] = await requestFromStore("readonly", tx => tx.objectStore(TRACK_PLAYLIST_STORE).getAll(), TRACK_PLAYLIST_STORE)
  return entries.sort((first, second) => first.name.localeCompare(second.name) || second.updatedAt - first.updatedAt)
}

function playlistName(name: string) {
  const normalized = name.trim()
  if (!normalized) throw new RangeError("Enter a playlist name.")
  return normalized
}

function withExistingTracks(tx: IDBTransaction, ids: readonly string[], apply: (ids: string[]) => void) {
  if (!ids.length) { apply([]); return }
  const request = tx.objectStore(LIBRARY_INDEX_STORE).getAllKeys()
  request.onsuccess = () => {
    const available = new Set(request.result)
    apply([...new Set(ids)].filter(id => available.has(id)))
  }
}

export async function createTrackPlaylist(name: string, trackIds: readonly string[] = []): Promise<TrackPlaylist> {
  const normalized = playlistName(name)
  const playlist = await studioTransaction([TRACK_PLAYLIST_STORE, LIBRARY_INDEX_STORE], "readwrite", tx => {
    const created: TrackPlaylist = { id: makeSavedRecordKey(), name: normalized, trackIds: [], updatedAt: Date.now() }
    withExistingTracks(tx, trackIds, ids => {
      created.trackIds = ids
      tx.objectStore(TRACK_PLAYLIST_STORE).add(created)
    })
    return () => created
  })
  publishTrackPlaylists()
  return playlist
}

async function editPlaylist(id: string, change: (entry: TrackPlaylist, existing: string[]) => TrackPlaylist | null,
  additions: readonly string[] = []) {
  const stores = additions.length ? [TRACK_PLAYLIST_STORE, LIBRARY_INDEX_STORE] : TRACK_PLAYLIST_STORE
  const result = await studioTransaction(stores, "readwrite", tx => {
    const store = tx.objectStore(TRACK_PLAYLIST_STORE)
    const request = store.get(id)
    let playlist: TrackPlaylist | null = null
    let changed = false
    request.onsuccess = () => {
      const previous: TrackPlaylist | undefined = request.result
      if (!previous) return
      withExistingTracks(tx, additions, existing => {
        playlist = change(previous, existing)
        if (playlist === previous) return
        changed = true
        if (playlist) {
          playlist = { ...playlist, updatedAt: Date.now() }
          store.put(playlist)
        } else store.delete(id)
      })
    }
    return () => ({ playlist, changed })
  })
  if (result.changed) publishTrackPlaylists()
  return result
}

export async function renameTrackPlaylist(id: string, name: string) {
  const normalized = playlistName(name)
  return (await editPlaylist(id, entry => normalized === entry.name ? entry : { ...entry, name: normalized })).playlist
}

export async function removeTrackPlaylist(id: string) {
  return (await editPlaylist(id, () => null)).changed
}

export async function addTrackToPlaylist(id: string, trackId: string) {
  return addTracksToPlaylist(id, [trackId])
}

export async function addTracksToPlaylist(id: string, ids: readonly string[]) {
  return (await editPlaylist(id, (entry, existing) => {
    const trackIds = [...new Set([...entry.trackIds, ...existing])]
    return trackIds.length === entry.trackIds.length ? entry : { ...entry, trackIds }
  }, ids)).playlist
}

function withoutTrack(entry: TrackPlaylist, trackId: string) {
  return entry.trackIds.includes(trackId) ? { ...entry, trackIds: entry.trackIds.filter(value => value !== trackId) } : entry
}

export async function removeTrackFromPlaylist(id: string, trackId: string) {
  return (await editPlaylist(id, entry => withoutTrack(entry, trackId))).playlist
}

export async function moveTrackInPlaylist(id: string, trackId: string, toIndex: number) {
  return (await editPlaylist(id, entry => {
    const from = entry.trackIds.indexOf(trackId)
    if (from < 0 || !Number.isFinite(toIndex)) return entry
    const to = Math.min(entry.trackIds.length - 1, Math.max(0, Math.trunc(toIndex)))
    if (from === to) return entry
    const trackIds = [...entry.trackIds]
    trackIds.splice(from, 1)
    trackIds.splice(to, 0, trackId)
    return { ...entry, trackIds }
  })).playlist
}

/** Drop references in the same transaction that removes a local library copy. */
export function removeTrackFromEveryPlaylist(transaction: IDBTransaction, trackId: string) {
  const store = transaction.objectStore(TRACK_PLAYLIST_STORE)
  const request = store.getAll()
  request.onsuccess = () => {
    for (const entry of request.result as TrackPlaylist[]) {
      const updated = withoutTrack(entry, trackId)
      if (updated !== entry) store.put({ ...updated, updatedAt: Date.now() })
    }
  }
}
