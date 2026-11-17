import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/playlistInterchange.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { decodeM3u, encodeM3u, libraryMediaMatcher, localMediaPath } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64"))

test("local references accept quoted Windows paths and Unicode local file URLs", () => {
  assert.equal(localMediaPath(' "V:\\Synthetic Sets\\Café #1.flac" '), "V:/Synthetic Sets/Café #1.flac")
  assert.equal(localMediaPath("file://localhost/V:/Synthetic%20Sets/Caf%C3%A9%20%231.flac"),
    "V:/Synthetic Sets/Café #1.flac")
  assert.equal(localMediaPath("file:///Volumes/Crates/%E6%98%A5.flac"), "/Volumes/Crates/春.flac")
  assert.equal(localMediaPath("Audio/Tone 100%.wav"), "Audio/Tone 100%.wav")
  for (const remote of [
    "https://example.test/stream.mp3", "ftp://example.test/stream.mp3",
    "file://example.test/Music/Tone.wav", "\\\\example.test\\Music\\Tone.wav",
    "file:///V:/bad%QQ.wav", "file:///V:/tone.wav?query=1", "file:///V:/tone.wav#anchor",
  ]) {
    assert.equal(localMediaPath(remote), null, remote)
  }
})

test("M3U8 reads BOM, CRLF, EXTINF and repeated local references in playlist order", () => {
  const text = [
    "\uFEFF#EXTM3U",
    "#EXTINF:68.5, Café, Opening",
    "V:\\Synthetic Sets\\Café #1.flac",
    "#EXTINF:10, Remote title",
    "https://example.test/recording.m4a",
    "Audio/春.wav",
    "#EXTINF:1, Later duplicate",
    "file:///V:/Synthetic%20Sets/Caf%C3%A9%20%231.flac",
    "file://example.test/Music/Track.wav",
  ].join("\r\n")
  const result = decodeM3u(text, "Test set")
  assert.deepEqual(result.tracks, [
    { id: "m3u-1", location: "V:/Synthetic Sets/Café #1.flac", title: "Café, Opening", durationSeconds: 68.5 },
    { id: "m3u-2", location: "Audio/春.wav", title: "春.wav", durationSeconds: undefined },
  ])
  assert.deepEqual(result.playlists, [{ name: "Test set", trackIds: ["m3u-1", "m3u-2", "m3u-1"] }])
  assert.match(result.warnings[0], /Skipped 2/)
  assert.match(result.warnings[1], /1 repeated entries/)
})

test("M3U8 export preserves portable order and escapes title line breaks", () => {
  const playlist = encodeM3u([
    { location: "Audio\\0001-Café #1.wav", title: "DJ\r\nCafé", durationSeconds: 119.6 },
    { location: "Audio/0002-春.flac", title: "春" },
  ])
  assert.equal(playlist, "#EXTM3U\n#EXTINF:120,DJ  Café\nAudio/0001-Café #1.wav\n#EXTINF:-1,春\nAudio/0002-春.flac\n")
  const decoded = decodeM3u(playlist, "Round trip")
  assert.deepEqual(decoded.tracks.map(track => [track.location, track.title, track.durationSeconds]), [
    ["Audio/0001-Café #1.wav", "DJ  Café", 120],
    ["Audio/0002-春.flac", "春", undefined],
  ])
  assert.deepEqual(decoded.playlists[0].trackIds, ["m3u-1", "m3u-2"])
  assert.throws(() => encodeM3u([{ location: "https://example.test/stream.mp3", title: "Stream" }]), /invalid playlist path/)
  assert.throws(() => encodeM3u([{ location: "#a.wav", title: "Comment" }]), /invalid playlist path/)
})

test("M3U rejects internet-only and HLS manifests and counts repeated references toward the limit", () => {
  assert.throws(() => decodeM3u("https://example.test/recording.m4a", "Remote"), /no local audio references/)
  assert.throws(() => decodeM3u("#EXTM3U\n#EXT-X-TARGETDURATION:8\nsegment.aac", "HLS"), /local audio playlist/)
  assert.throws(() => decodeM3u("#EXTM3U\nAudio/\0Track.wav", "Broken"), /local audio playlist/)
  assert.throws(() => decodeM3u(Array(10_001).fill("Audio/Repeat.wav").join("\n"), "Too long"), /10,000 entries/)
})

test("library matching selects only unambiguous path suffixes and suggests filename-only matches", () => {
  const north = { id: "a", fileName: "Café #1.flac", relativePath: "North/Night/Sets/Café #1.flac",
    relativePaths: ["Alternate/Opening/Café #1.flac"] }
  const south = { id: "b", fileName: "Café #1.flac", relativePath: "South/Day/Sets/Café #1.flac" }
  const standalone = { id: "c", fileName: "Standalone.wav" }
  const absent = { id: "d", fileName: "Café #1.flac", relativePath: "North/Night/Sets/Café #1.flac", needsAudio: true }
  const match = libraryMediaMatcher([north, south, standalone, absent])
  assert.deepEqual(match("V:\\Cloned\\NIGHT\\Sets\\Cafe\u0301 #1.flac"), { match: north, candidates: [north] })
  assert.deepEqual(match("file:///V:/Opening/Caf%C3%A9%20%231.flac"), { match: north, candidates: [north] })
  assert.deepEqual(match("V:/Cloned/Day/Sets/Café #1.flac"), { match: south, candidates: [south] })
  assert.deepEqual(match("Sets/Café #1.flac"), { match: null, candidates: [north, south] })
  assert.deepEqual(match("V:/Other/Café #1.flac"), { match: null, candidates: [north, south] })
  assert.deepEqual(match("Standalone.wav"), { match: null, candidates: [standalone] })
  assert.deepEqual(match("../Night/Sets/Café #1.flac"), { match: null, candidates: [north, south] })
  assert.deepEqual(match("https://example.test/Standalone.wav"), { match: null, candidates: [] })
})
