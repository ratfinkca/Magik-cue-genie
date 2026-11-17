import type { Sidecar } from "./cues"
import type { DeckId } from "./transitionAudio"

interface SavedDeckBase {
  deck: DeckId
  key: string
  name: string
  start: number
  sidecar?: Sidecar
}

export type SavedDeck = SavedDeckBase & (
  { kind: "demo" } |
  { kind: "library"; libraryId: string } |
  { kind: "file"; audio: Blob; fileName: string; lastModified: number }
)

export type SavedDeckHead = { key: string; start: number; position: number }

const databaseName = "magik.cue-studio"
const storeName = "deck-session"
const sidecarStore = "deck-sidecars"
export const LIBRARY_INDEX_STORE = "track-library"
export const LIBRARY_MEDIA_STORE = "track-media"
export const LIBRARY_PREP_STORE = "track-prep"
export const TRACK_PLAYLIST_STORE = "track-playlists"
const headPrefix = "magik.studio.deckHead."

function openDeckStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new DOMException("Local track storage is unavailable.", "NotSupportedError"))
      return
    }
    const request = indexedDB.open(databaseName, 4)
    let blocked = false
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "deck" })
      if (!database.objectStoreNames.contains(sidecarStore)) database.createObjectStore(sidecarStore, { keyPath: "deck" })
      for (const store of [LIBRARY_INDEX_STORE, LIBRARY_MEDIA_STORE, LIBRARY_PREP_STORE, TRACK_PLAYLIST_STORE]) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "id" })
      }
    }
    request.onblocked = () => {
      blocked = true
      reject(new DOMException("Local track storage is being updated in another tab.", "InvalidStateError"))
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      if (blocked) database.close()
      else resolve(database)
    }
  })
}

export async function studioTransaction<T>(stores: string | string[], mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => () => T): Promise<T> {
  const database = await openDeckStore()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(stores, mode)
      transaction.onabort = () => reject(transaction.error ?? new DOMException("Local storage operation was interrupted.", "AbortError"))
      let result: () => T
      try { result = operation(transaction) } catch (cause) {
        transaction.abort()
        reject(cause)
        return
      }
      transaction.oncomplete = () => {
        try { resolve(result()) } catch (cause) { reject(cause) }
      }
    })
  } finally {
    database.close()
  }
}

export function requestFromStore<T>(mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => IDBRequest<T>,
  stores: string | string[] = storeName): Promise<T> {
  return studioTransaction(stores, mode, tx => {
    const request = operation(tx)
    return () => request.result
  })
}

export function readSavedDecks(): Promise<unknown[]> {
  return requestFromStore("readonly", tx => tx.objectStore(storeName).getAll())
}

export async function writeSavedDeck(record: SavedDeck): Promise<void> {
  await requestFromStore("readwrite", tx => {
    tx.objectStore(sidecarStore).delete(record.deck)
    return tx.objectStore(storeName).put(record)
  }, [storeName, sidecarStore])
}

export async function removeSavedDeck(deck: DeckId): Promise<void> {
  await requestFromStore("readwrite", tx => {
    tx.objectStore(sidecarStore).delete(deck)
    return tx.objectStore(storeName).delete(deck)
  }, [storeName, sidecarStore])
}

export async function clearSavedDecks(): Promise<void> {
  await requestFromStore("readwrite", tx => {
    tx.objectStore(sidecarStore).clear()
    return tx.objectStore(storeName).clear()
  }, [storeName, sidecarStore])
}

export async function readSavedDeckSidecar(deck: DeckId, key: string): Promise<Sidecar | undefined> {
  const value = await requestFromStore("readonly", tx => tx.objectStore(sidecarStore).get(deck), sidecarStore)
  return value?.key === key ? value.sidecar : undefined
}

export async function writeSavedDeckSidecar(deck: DeckId, key: string, sidecar: Sidecar): Promise<void> {
  await requestFromStore("readwrite", tx => tx.objectStore(sidecarStore).put({ deck, key, sidecar }), sidecarStore)
}

export function asSavedDeck(value: unknown): SavedDeck | null {
  if (!value || typeof value !== "object") return null
  const record = value as Partial<SavedDeck>
  if ((record.deck !== "A" && record.deck !== "B") || typeof record.key !== "string" || !record.key
    || typeof record.name !== "string" || !Number.isFinite(record.start)) return null
  if (record.kind === "demo") return record as SavedDeck
  if (record.kind === "library" && typeof record.libraryId === "string" && /^[a-f0-9]{64}$/.test(record.libraryId)) return record as SavedDeck
  if (record.kind === "file" && record.audio instanceof Blob && typeof record.fileName === "string"
    && Number.isFinite(record.lastModified)) return record as SavedDeck
  return null
}

export function makeSavedRecordKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

export function readSavedDeckHead(deck: DeckId, key: string): SavedDeckHead | null {
  try {
    const value = JSON.parse(localStorage.getItem(headPrefix + deck) || "null")
    return value?.key === key && Number.isFinite(value.start) && Number.isFinite(value.position) ? value : null
  } catch { return null }
}

export function writeSavedDeckHead(deck: DeckId, head: SavedDeckHead) {
  try { localStorage.setItem(headPrefix + deck, JSON.stringify(head)) } catch { /* Head checkpoints are optional. */ }
}

export function removeSavedDeckHead(deck: DeckId) {
  try { localStorage.removeItem(headPrefix + deck) } catch { /* Head checkpoints are optional. */ }
}
