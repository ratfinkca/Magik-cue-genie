import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
async function compile(file) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), "utf8")
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}
const sessionUrl = moduleUrl(await compile("deckSession"))
const session = await import(sessionUrl)
const playlistUrl = moduleUrl((await compile("trackPlaylist"))
  .replaceAll(/["']\.\/deckSession["']/g, JSON.stringify(sessionUrl)))
const playlists = await import(playlistUrl)
const metadataUrl = moduleUrl((await compile("trackMetadata"))
  .replaceAll(/["']music-metadata["']/g, JSON.stringify(import.meta.resolve("music-metadata"))))
const matchEvidenceUrl = moduleUrl(await compile("trackMatchEvidence"))
const libraryUrl = moduleUrl((await compile("trackLibrary"))
  .replaceAll(/["']\.\/deckSession["']/g, JSON.stringify(sessionUrl))
  .replaceAll(/["']\.\/trackPlaylist["']/g, JSON.stringify(playlistUrl))
  .replaceAll(/["']\.\/trackMetadata["']/g, JSON.stringify(metadataUrl))
  .replaceAll(/["']\.\/trackMatchEvidence["']/g, JSON.stringify(matchEvidenceUrl))
  .replaceAll(/["']\.\/key["']/g, JSON.stringify(moduleUrl(await compile("key")))))
const library = await import(libraryUrl)
const trackTimeUrl = moduleUrl(await compile("trackTime"))
const cuesUrl = moduleUrl((await compile("cues")).replaceAll(/["']\.\/trackTime["']/g, JSON.stringify(trackTimeUrl)))
const midiPreferencesUrl = moduleUrl((await compile("midiPreferences"))
  .replaceAll(/["']\.\/midiMapping["']/g, JSON.stringify(moduleUrl(await compile("midiMapping")))))
const backup = await import(moduleUrl((await compile("studioBackupData"))
  .replaceAll(/["']\.\/cues["']/g, JSON.stringify(cuesUrl))
  .replaceAll(/["']\.\/trackLibrary["']/g, JSON.stringify(libraryUrl))
  .replaceAll(/["']\.\/deckSession["']/g, JSON.stringify(sessionUrl))
  .replaceAll(/["']\.\/midiPreferences["']/g, JSON.stringify(midiPreferencesUrl))
  .replaceAll(/["']\.\/trackPlaylist["']/g, JSON.stringify(playlistUrl))))
const interchangeLinks = { trackLibrary: libraryUrl, trackPlaylist: playlistUrl, cues: cuesUrl }
for (const name of ["beatGrid", "loops", "playlistInterchange", "rekordboxXml"]) {
  interchangeLinks[name] = moduleUrl(await compile(name))
}
const interchange = await import(moduleUrl((await compile("libraryInterchange"))
  .replaceAll(/["']\.\/([a-zA-Z]+)["']/g, (_specifier, name) => JSON.stringify(interchangeLinks[name]))))

function mockStorage(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original)
    else delete globalThis[name]
  })
}

function fakeIndexedDb() {
  const stores = new Map()
  const puts = []
  const opened = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: (name, { keyPath }) => stores.set(name, { keyPath, data: new Map() }),
    close() {},
    transaction() {
      const tx = {
        objectStore(name) {
          const { keyPath, data: store } = stores.get(name)
          function put(record) { puts.push(name); store.set(record[keyPath], structuredClone(record)); return {} }
          function read(value) {
            const request = { readyState: "pending", result: undefined }
            queueMicrotask(() => {
              request.readyState = "done"
              request.result = structuredClone(value)
              request.onsuccess?.()
            })
            return request
          }
          return {
            put,
            add(record) {
              if (store.has(record[keyPath])) throw new DOMException("Duplicate key", "ConstraintError")
              return put(record)
            },
            get(key) { return read(store.get(key)) },
            getAll() { return read(Array.from(store.values())) },
            getAllKeys() { return read(Array.from(store.keys())) },
            delete(key) { store.delete(key); return {} },
            clear() { store.clear(); return {} },
          }
        },
      }
      setImmediate(() => tx.oncomplete())
      return tx
    },
  }
  return { puts, open() {
    const request = { result: opened }
    queueMicrotask(() => {
      if (!stores.size) request.onupgradeneeded()
      request.onsuccess()
    })
    return request
  } }
}

function generatedWav(seconds) {
  const rate = 8000
  const frames = seconds * rate
  const buffer = Buffer.alloc(44 + 2 * frames)
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write("WAVEfmt ", 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(2 * rate, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(2 * frames, 40)
  for (let frame = 0; frame < frames; frame++) {
    buffer.writeInt16LE(Math.round(1200 * Math.sin(frame / rate * 2 * Math.PI * 440)), 44 + frame * 2)
  }
  return new File([buffer], "Étude #1.wav", { type: "audio/wav" })
}

function memoryDirectory() {
  const dirs = new Map(), files = new Map()
  function requireExisting(map, name, options, create) {
    if (!map.has(name) && options?.create) map.set(name, create())
    if (!map.has(name)) throw new DOMException("Missing", "NotFoundError")
    return map.get(name)
  }
  return { dirs, files,
    async getDirectoryHandle(name, options) { return requireExisting(dirs, name, options, memoryDirectory) },
    async getFileHandle(name, options) {
      requireExisting(files, name, options, () => null)
      return { async createWritable() {
        let temporary
        return { async write(value) { temporary = value }, async close() { files.set(name, temporary) }, async abort() {} }
      } }
    },
  }
}

test("file interchange keeps existing prep, deduplicates retries, and stages byte-exact audio with indexes", async t => {
  mockStorage(t, "indexedDB", fakeIndexedDb())
  const file = generatedWav(8)
  const selection = new Map([["external-track", { file }]])
  const external = {
    tracks: [{ id: "external-track", location: "D:/Music/Étude #1.wav", title: "External title", durationSeconds: 8,
      bpm: 120, cuePoints: [{ name: "Loop", type: "loop", timeSeconds: 2, endSeconds: 4, hotCueSlot: 2 }],
      tempo: [{ timeSeconds: .125, bpm: 120, meter: "4/4", beat: 1 }] }],
    playlists: [{ name: "Local test", trackIds: ["external-track"] }], warnings: [],
  }
  const decode = async source => { assert.equal(source.name, file.name); return { duration: 8 } }
  const first = await interchange.importInterchangePlaylists(external, "rekordbox", selection, decode)
  assert.deepEqual([first.tracks, first.playlists, first.preparations], [1, 1, 1])
  const [playlist] = await playlists.readTrackPlaylists()
  const [id] = playlist.trackIds
  const preparation = await library.readTrackPrep(id)
  assert.deepEqual(preparation.cues[0].metadata.loop, { kind: "manual", active: false, end_seconds: 4 })
  assert.equal(preparation.cues[0].metadata.studio_rekordbox_cue.hotCueSlot, 2)
  const retry = await interchange.importInterchangePlaylists(external, "rekordbox", selection, decode)
  assert.deepEqual([retry.playlists, retry.unchangedPlaylists, retry.kept], [0, 1, 1])
  assert.deepEqual(await library.readTrackPrep(id), preparation)
  const root = memoryDirectory()
  const stage = await interchange.stagePlaylistExport(root, playlist, interchange.exportParentPath("R:\\"), () => {})
  const folder = root.dirs.get(stage.name)
  const [name, copied] = [...folder.dirs.get("Audio").files.entries()][0]
  assert.equal(stage.tracks, 1)
  assert.deepEqual(await copied.arrayBuffer(), await file.arrayBuffer())
  assert.match(folder.files.get("playlist.m3u8"), /Audio\/0001-Étude #1\.wav/)
  assert.match(folder.files.get("rekordbox.xml"), /Location="file:\/\/localhost\/R:\/Cue%20Studio/)
  assert.match(folder.files.get("rekordbox.xml"), /Inizio="0\.125"/)
  assert.match(folder.files.get("rekordbox.xml"), /Start="2" End="4" Num="2"/)
  assert.equal(JSON.parse(folder.files.get("export-report.json")).media[0].file, "Audio/" + name)
})

test("saved decks keep encoded bytes separate from cue sidecar updates", async t => {
  const database = fakeIndexedDb()
  mockStorage(t, "indexedDB", database)
  const a = {
    deck: "A", key: "take-a", kind: "file", name: "Test tone", start: -4,
    audio: new Blob([Uint8Array.of(1, 2, 3, 4)], { type: "audio/wav" }), fileName: "tone.wav", lastModified: 22,
  }
  const b = { deck: "B", key: "demo-b", kind: "demo", name: "Demo B", start: 16 }
  await session.writeSavedDeck(a)
  await session.writeSavedDeck(b)
  const sidecar = { schema_version: 1, source_file: "tone.wav", cues: [], analysis: {}, warnings: [] }
  await session.writeSavedDeckSidecar("A", a.key, sidecar)
  const records = (await session.readSavedDecks()).map(session.asSavedDeck)
  assert.deepEqual(new Uint8Array(await records[0].audio.arrayBuffer()), Uint8Array.of(1, 2, 3, 4))
  assert.equal(records[0].start, -4)
  assert.deepEqual(records[1], b)
  assert.deepEqual(await session.readSavedDeckSidecar("A", a.key), sidecar)
  assert.equal(await session.readSavedDeckSidecar("A", "older-track"), undefined)
  assert.deepEqual(database.puts, ["deck-session", "deck-session", "deck-sidecars"])
  await session.writeSavedDeck({ ...a, key: "replacement" })
  assert.equal(await session.readSavedDeckSidecar("A", a.key), undefined)
  await session.clearSavedDecks()
  assert.deepEqual(await session.readSavedDecks(), [])
})

test("playhead checkpoints only attach to the exact saved deck and ignore bad values", t => {
  const map = new Map()
  mockStorage(t, "localStorage", { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key) })
  const head = { key: "track-key", start: -4, position: 21.5 }
  session.writeSavedDeckHead("A", head)
  assert.deepEqual(session.readSavedDeckHead("A", "track-key"), head)
  assert.equal(session.readSavedDeckHead("A", "old-track"), null)
  assert.equal(session.readSavedDeckHead("B", "track-key"), null)
  session.writeSavedDeckHead("A", { ...head, position: NaN })
  assert.equal(session.readSavedDeckHead("A", "track-key"), null)
  session.removeSavedDeckHead("A")
  assert.equal(map.size, 0)
})

test("unavailable IndexedDB is a storage error rather than an empty saved session", async t => {
  mockStorage(t, "indexedDB", undefined)
  await assert.rejects(session.readSavedDecks(), { name: "NotSupportedError" })
})

test("library tracks deduplicate renamed bytes, retain prepared data separately, and can be removed", async t => {
  const database = fakeIndexedDb()
  mockStorage(t, "indexedDB", database)
  const bytes = Uint8Array.of(33, 1, 4, 9, 11, 77)
  const a = new File([bytes], "First copy.wav", { type: "audio/wav", lastModified: 22 })
  const renamed = new File([bytes], "Renamed.wav", { type: "audio/wav", lastModified: 100 })
  const distinct = new File([Uint8Array.of(10, 67)], "First copy.wav", { type: "audio/wav", lastModified: 22 })
  const first = await library.addLibraryFile(a)
  assert.match(first.entry.id, /^[a-f0-9]{64}$/)
  assert.equal(first.added, true)
  const again = await library.addLibraryFile(renamed)
  assert.equal(again.added, false)
  assert.equal(again.entry.id, first.entry.id)
  assert.notEqual((await library.addLibraryFile(distinct)).entry.id, first.entry.id)
  assert.equal(database.puts.filter(store => store === "track-media").length, 2)

  const id = first.entry.id
  const prep = { schema_version: 1, source_file: a.name, analysis: { estimated_bpm: 126 }, warnings: [],
    cues: [{ label: "Loop", time_seconds: 4.25, reason: "Synthetic preparation", confidence: 1,
      metadata: { color: "#5dc9fa", studio_id: "fixture-loop",
        loop: { start_seconds: 4.25, end_seconds: 7.125, kind: "manual", active: false } } }] }
  const origin = {}
  const observed = []
  const unsubscribe = library.subscribeTrackPrep(id, (sidecar, source, status) => observed.push([sidecar, source, status]))
  const saved = library.writeTrackPrep(id, prep, origin)
  assert.deepEqual(observed, [[prep, origin, "saving"]])
  const newer = { ...prep, analysis: { estimated_bpm: 126.5 } }
  const newerSave = library.writeTrackPrep(id, newer)
  assert.deepEqual(await library.readTrackPrep(id), newer)
  await Promise.all([saved, newerSave])
  assert.deepEqual(observed.map(([,, status]) => status), ["saving", "saving", "saved"])
  unsubscribe()
  assert.deepEqual(await library.readTrackPrep(id), newer)
  const loaded = await library.openLibraryFile(id)
  assert.equal(loaded.file.name, a.name)
  assert.equal(loaded.file.lastModified, 22)
  assert.deepEqual(new Uint8Array(await loaded.file.arrayBuffer()), bytes)
  assert.equal(loaded.entry.prepared, true)
  assert.equal(loaded.entry.bpm, 126.5)
  assert.equal(database.puts.filter(store => store === "track-media").length, 2)

  const pointer = { deck: "A", key: "a", kind: "library", name: "First copy", start: -4, libraryId: id }
  await session.writeSavedDeck(pointer)
  assert.deepEqual((await session.readSavedDecks()).map(session.asSavedDeck), [pointer])
  await session.clearSavedDecks()
  assert.deepEqual(await library.readTrackPrep(id), newer)
  await library.deleteLibraryTrack(id)
  await assert.rejects(library.writeTrackPrep(id, prep), { name: "NotFoundError" })
  assert.equal(await library.openLibraryFile(id), null)
  assert.equal(await library.readTrackPrep(id), null)
  assert.equal((await library.readLibraryTracks()).length, 1)

  await library.addLibraryFile(renamed)
  const stale = assert.rejects(library.writeTrackPrep(id, prep), { name: "NotFoundError" })
  await library.deleteLibraryTrack(id)
  await library.addLibraryFile(a)
  await stale
  assert.equal(await library.readTrackPrep(id), null)
})

test("genre backfill reads existing local audio without rewriting media or preparation", async t => {
  const database = fakeIndexedDb()
  mockStorage(t, "indexedDB", database)
  const genre = Buffer.from("\0Tech House")
  const header = Buffer.alloc(20)
  header.write("ID3\x03"); header[9] = 10 + genre.length
  header.write("TCON", 10); header.writeUInt32BE(genre.length, 14)
  const file = new File([header, genre], "Local test.mp3", { type: "audio/mpeg" })
  const { entry: { id, genres } } = await library.addLibraryFile(file)
  assert.deepEqual(genres, ["Tech House"])
  const prep = { schema_version: 1, source_file: file.name, cues: [], analysis: { estimated_bpm: 126.5 }, warnings: [] }
  await library.writeTrackPrep(id, prep)
  const [{ genres: oldGenres, ...legacy }] = await library.readLibraryTracks()
  await session.requestFromStore("readwrite", tx => tx.objectStore(session.LIBRARY_INDEX_STORE).put(legacy), session.LIBRARY_INDEX_STORE)
  let notifications = 0
  const stop = library.subscribeLibrary(() => notifications++)
  const before = database.puts.length
  assert.deepEqual(await library.refreshLibraryGenres([id, id, "unavailable"]), { tagged: 1, untagged: 0, unavailable: 1 })
  assert.deepEqual(await library.refreshLibraryGenres([id]), { tagged: 0, untagged: 0, unavailable: 0 })
  stop()
  assert.equal(notifications, 1)
  assert.deepEqual(database.puts.slice(before), [session.LIBRARY_INDEX_STORE])
  assert.deepEqual(await library.readLibraryTracks(), [{ ...legacy, genres: oldGenres }])
  assert.deepEqual(await library.readTrackPrep(id), prep)
})

test("library marks analysis and cue counts independently of manual review", async t => {
  mockStorage(t, "indexedDB", fakeIndexedDb())
  const file = new File([Uint8Array.of(55, 1, 8)], "Preparation.wav", { type: "audio/wav" })
  const { entry: { id } } = await library.addLibraryFile(file)
  const libraryRow = async () => (await library.readLibraryTracks()).find(track => track.id === id)
  const cue = { label: "Cue 1", time_seconds: 1.375, reason: "Manual", confidence: 1 }
  const manual = { schema_version: 1, source_file: file.name, cues: [cue], analysis: {}, warnings: [] }
  await library.writeTrackPrep(id, manual)
  assert.equal((await libraryRow()).analysisStatus, "none")
  assert.equal((await libraryRow()).cueCount, 1)
  assert.deepEqual((await libraryRow()).matchEvidence, { version: 1 })
  const analyzed = { ...manual, analysis: { studio_base: { status: "ready" }, estimated_bpm: 125,
    energy_summary: { max_rms: .3, mean_rms: .15, normalized_envelope: [.35, .55, .8, 1] } } }
  await library.writeTrackPrep(id, analyzed)
  assert.equal((await libraryRow()).analysisStatus, "analyzed")
  const { matchEvidence, ...legacy } = await libraryRow()
  assert.ok(matchEvidence.energy.rating >= 5)
  await session.requestFromStore("readwrite", tx => tx.objectStore(session.LIBRARY_INDEX_STORE).put(legacy), session.LIBRARY_INDEX_STORE)
  await library.backfillLibraryPrepSummaries([id])
  assert.deepEqual((await libraryRow()).matchEvidence, matchEvidence)
  assert.deepEqual(await library.readTrackPrep(id), analyzed)
  assert.equal((await libraryRow()).reviewStatus, undefined)
  await library.setLibraryReviewStatus(id, "reviewed")
  await library.setLibraryReviewStatus(id, "approved")
  await library.writeTrackPrep(id, { ...analyzed, warnings: ["Same cue and tempo"] })
  assert.equal((await libraryRow()).reviewStatus, "approved")
  await library.writeTrackPrep(id, { ...analyzed, cues: [{ ...cue, time_seconds: 2 }] })
  assert.equal((await libraryRow()).reviewStatus, undefined)
  assert.equal((await libraryRow()).cueCount, 1)
  await library.setLibraryReviewStatus(id, "approved")
  const saved = await library.readTrackPrep(id)
  const grid = { version: 1, bpm: 126, anchor_seconds: .021 }
  await library.writeTrackPrep(id, { ...saved, analysis: { ...saved.analysis, studio_manual_grid: grid } })
  assert.deepEqual((await library.readTrackPrep(id)).analysis.studio_manual_grid, grid)
  assert.equal((await libraryRow()).bpm, 125)
  assert.equal((await libraryRow()).reviewStatus, undefined)
})

test("folder import keeps relative aliases, filters auxiliary files, and leaves one copy of matching audio", async t => {
  const database = fakeIndexedDb()
  mockStorage(t, "indexedDB", database)
  function inFolder(name, path, payload, options) {
    const file = new File([payload], name, options)
    Object.defineProperty(file, "webkitRelativePath", { value: path })
    return file
  }
  const audio = Uint8Array.of(87, 65, 86, 69, 1, 0, 0, 1)
  const same = [
    inFolder("first.WAV", "Sets/Opening/first.WAV", audio),
    inFolder("alias.wav", "Sets/Closing/alias.wav", audio, { type: "audio/wav" }),
    inFolder("invalid.wav", "C:/Private/invalid.wav", audio),
    inFolder("traversal.wav", "Sets/../traversal.wav", audio),
  ]
  const auxiliary = [
    inFolder("cues.json", "Sets/cues.json", "{}", { type: "application/json" }),
    inFolder("cover.jpg", "Sets/cover.jpg", "photo", { type: "image/jpeg" }),
    inFolder("playlist.m3u", "Sets/playlist.m3u", "#EXTM3U", { type: "audio/mpegurl" }),
  ]
  const observed = []
  const unsubscribe = library.subscribeLibrary(() => observed.push("updated"))
  assert.deepEqual(await library.addLibraryFiles([same[0], ...auxiliary]),
    { added: 1, existing: 0, relinked: 0, failed: 0, skipped: 3, lastError: undefined })
  assert.deepEqual(await library.addLibraryFiles(same.slice(1)),
    { added: 0, existing: 3, relinked: 0, failed: 0, skipped: 0, lastError: undefined })
  unsubscribe()
  assert.deepEqual(observed, ["updated", "updated"])
  const [entry] = await library.readLibraryTracks()
  assert.equal(entry.relativePath, "Sets/Opening/first.WAV")
  assert.deepEqual(entry.relativePaths, ["Sets/Opening/first.WAV", "Sets/Closing/alias.wav"])
  assert.equal(database.puts.filter(store => store === "track-media").length, 1)
})

test("named playlists save deduplicated order and separate playlist deletion from audio removal", async t => {
  mockStorage(t, "indexedDB", fakeIndexedDb())
  const first = (await library.addLibraryFile(new File(["tone a"], "A.wav"))).entry.id
  const second = (await library.addLibraryFile(new File(["tone b"], "B.wav"))).entry.id
  const third = (await library.addLibraryFile(new File(["tone c"], "C.wav"))).entry.id
  const observed = []
  const unsubscribe = playlists.subscribeTrackPlaylists(() => observed.push("updated"))
  await assert.rejects(playlists.createTrackPlaylist("   "), RangeError)
  const playlist = await playlists.createTrackPlaylist("  Opening  ", [first, second, first, "removed"])
  assert.equal(playlist.name, "Opening")
  assert.deepEqual(playlist.trackIds, [first, second])
  await playlists.addTracksToPlaylist(playlist.id, [second, third])
  await playlists.moveTrackInPlaylist(playlist.id, third, 0)
  await playlists.renameTrackPlaylist(playlist.id, "Main room")
  let all = await playlists.readTrackPlaylists()
  assert.equal(all[0].name, "Main room")
  assert.deepEqual(all[0].trackIds, [third, first, second])

  await playlists.removeTrackFromPlaylist(playlist.id, first)
  assert.ok(await library.openLibraryFile(first))
  await library.deleteLibraryTrack(third)
  await playlists.addTracksToPlaylist(playlist.id, [third])
  all = await playlists.readTrackPlaylists()
  assert.deepEqual(all[0].trackIds, [second])
  assert.equal(await playlists.removeTrackPlaylist(playlist.id), true)
  assert.equal(await playlists.removeTrackPlaylist(playlist.id), false)
  assert.deepEqual(await playlists.readTrackPlaylists(), [])
  assert.ok(await library.openLibraryFile(second))
  unsubscribe()
  assert.equal(observed.length, 7)
})

test("a portable backup restores preparation and playlist order, then relinks exact renamed audio", async t => {
  let active = fakeIndexedDb()
  mockStorage(t, "indexedDB", { open(...args) { return active.open(...args) } })
  const settings = new Map([
    ["magik.keyNotation", "camelot"], ["magik.studio.preparation.v1", '{"cueColor":"#78f3c3"}'],
    ["magik.studio.midi.v1", '{"version":1,"bindings":[{"inputId":"synthetic-port","actionId":"gain-a","control":{"kind":"cc","channel":1,"number":7}}]}'],
    ["magik.studio.diagnostics.v1", "private diagnostic"],
  ])
  mockStorage(t, "localStorage", { getItem: key => settings.get(key) ?? null, setItem: (key, value) => settings.set(key, value) })
  const file = new File(["generated tone"], "Tone.wav")
  const first = (await library.addLibraryFile(file)).entry.id
  const second = (await library.addLibraryFile(new File(["different tone"], "Other.wav"))).entry.id
  const preparation = { schema_version: 1, source_file: file.name, analysis: { duration_seconds: 60, estimated_bpm: 126,
    energy_summary: { max_rms: .6, mean_rms: .32, normalized_envelope: [.6, 1, .75, .9] } }, warnings: [],
    cues: [{ label: "Entry", time_seconds: 1.5, confidence: 1, reason: "Synthetic loop",
      metadata: { studio_id: "test-loop", color: "#78f3c3", loop: { kind: "manual", active: false, end_seconds: 3.5 } } }] }
  await library.writeTrackPrep(first, preparation)
  const matchEvidence = (await library.openLibraryFile(first)).entry.matchEvidence
  assert.ok(matchEvidence.energy.rating >= 8)
  await library.setLibraryReviewStatus(first, "approved")
  const order = await playlists.createTrackPlaylist("Opening", [second, first])
  const exported = JSON.stringify(await backup.readStudioBackup(), null, 2)
  assert.equal(exported.includes("private diagnostic"), false)
  assert.equal(exported.includes("generated tone"), false)
  assert.throws(() => backup.parseStudioBackup(exported.replace('"schema_version": 1', '"schema_version": 2')), /version 1/)
  const document = backup.parseStudioBackup(exported)
  assert.deepEqual(document.tracks.find(item => item.track.id === first).track.matchEvidence, matchEvidence)
  assert.deepEqual(document.preferences["magik.studio.preparation.v1"], { cueColor: "#78f3c3" })
  const savedMappings = settings.get("magik.studio.midi.v1")
  assert.deepEqual(document.preferences["magik.studio.midi.v1"], JSON.parse(savedMappings))

  active = fakeIndexedDb()
  settings.set("magik.keyNotation", "standard")
  settings.delete("magik.studio.midi.v1")
  const restore = await backup.restoreStudioBackup(document, { replaceMatched: false, restorePreferences: true })
  assert.equal(restore.tracksAdded, 2)
  assert.equal(restore.needsAudio, 2)
  assert.equal(restore.preparationRestored, 1)
  assert.equal(settings.get("magik.keyNotation"), "camelot")
  assert.equal(settings.get("magik.studio.midi.v1"), savedMappings)
  assert.equal(await library.openLibraryFile(first), null)
  assert.ok((await library.readLibraryTracks()).every(track => track.needsAudio))
  assert.deepEqual((await library.readLibraryTracks()).find(track => track.id === first).matchEvidence, matchEvidence)
  assert.deepEqual(await playlists.readTrackPlaylists(), [order])

  const missing = await library.addLibraryFiles([new File(["different media"], "Tone.wav")])
  assert.equal(missing.relinked, 0)
  assert.equal(await library.openLibraryFile(first), null)
  const matched = await library.addLibraryFiles([new File(["generated tone"], "Renamed.wav")])
  assert.deepEqual(matched, { added: 0, existing: 0, relinked: 1, failed: 0, skipped: 0, lastError: undefined })
  assert.equal((await library.openLibraryFile(first)).file.name, file.name)
  assert.equal((await library.openLibraryFile(first)).entry.needsAudio, undefined)
  assert.equal((await library.openLibraryFile(first)).entry.reviewStatus, "approved")
  assert.deepEqual((await library.openLibraryFile(first)).entry.matchEvidence, matchEvidence)
  assert.deepEqual(await library.readTrackPrep(first), document.tracks.find(item => item.track.id === first).preparation)

  await library.writeTrackPrep(first, { ...preparation, cues: [{ ...preparation.cues[0], label: "Local edit" }] })
  await playlists.renameTrackPlaylist(order.id, "Local title")
  const defaults = await backup.restoreStudioBackup(document, { replaceMatched: false, restorePreferences: false })
  assert.equal(defaults.preparationKept, 1)
  assert.equal(defaults.playlistsKept, 1)
  assert.equal((await library.readTrackPrep(first)).cues[0].label, "Local edit")
  assert.equal((await playlists.readTrackPlaylists())[0].name, "Local title")
  const statuses = []
  const unsubscribe = library.subscribeTrackPrep(first, (sidecar, _, status) => statuses.push([sidecar.cues[0].label, status]))
  await backup.restoreStudioBackup(document, { replaceMatched: true, restorePreferences: false })
  unsubscribe()
  assert.deepEqual(statuses, [["Entry", "saved"]])
  assert.equal((await library.openLibraryFile(first)).entry.reviewStatus, "approved")
  assert.deepEqual(await playlists.readTrackPlaylists(), [order])
})
