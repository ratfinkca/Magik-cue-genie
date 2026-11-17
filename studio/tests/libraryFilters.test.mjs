import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/libraryFilters.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { compileLibraryFilters, newLibraryFilterRule } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

const localTracks = [
  { id: "first", title: "Opening", artist: "Avery", genres: ["Disco", " Deep House "], bpm: 125, duration: 300, prepared: true },
  { id: "second", title: "Second", genres: ["Techno"], bpm: 130, duration: 360, prepared: true },
  { id: "third", title: "Third", artist: "Avery", genres: ["deep house"], duration: 245, prepared: false },
  { id: "fourth", title: "Last", name: "Filename", fileName: "Filename.wav", prepared: false },
]

function rule(id, field, value, extra) {
  return { ...newLibraryFilterRule(id, field), value, ...extra }
}

test("all and any combine column predicates and preserve their incoming order", () => {
  const rules = [rule(1, "genre", "  Deep HOUSE  ", { condition: "is" }), rule(2, "prepared", "yes")]
  const all = compileLibraryFilters(rules, "all")
  const any = compileLibraryFilters(rules, "any")
  assert.deepEqual([...all.activeFields], ["genre", "prepared"])
  assert.deepEqual(localTracks.filter(all.matches).map(track => track.id), ["first"])
  assert.deepEqual(localTracks.filter(any.matches).map(track => track.id), ["first", "second", "third"])
})

test("numeric filters use inclusive seconds and BPM with no coercion for missing data", () => {
  const low = rule(1, "bpm", "125", { maximum: "130" })
  const high = rule(2, "duration", "", { maximum: "300" })
  assert.deepEqual(localTracks.filter(compileLibraryFilters([low, high], "all").matches).map(track => track.id), ["first"])
  assert.deepEqual(localTracks.filter(compileLibraryFilters([low, high], "any").matches).map(track => track.id), ["first", "second", "third"])
})

test("invalid ranges and blank rules are inactive, and empty genre and artist can be targeted", () => {
  const matcher = compileLibraryFilters([
    rule(1, "bpm", "133", { maximum: "121" }),
    rule(2, "track", "  "),
    rule(3, "genre", "", { condition: "missing" }),
    rule(4, "artist", "", { condition: "missing" }),
  ], "all")
  assert.deepEqual([...matcher.invalid], [1])
  assert.equal(matcher.count, 2)
  assert.deepEqual(localTracks.filter(matcher.matches).map(track => track.id), ["fourth"])
  assert.ok(compileLibraryFilters([rule(1, "track", "filename.wav")], "all").matches(localTracks[3]))
})

test("energy ranges match measured ratings and exclude tracks without evidence", () => {
  const matcher = compileLibraryFilters([rule(1, "energy", "7", { maximum: "9" })], "all")
  assert.equal(matcher.matches({ matchEvidence: { energy: { rating: 7 } } }), true)
  assert.equal(matcher.matches({ matchEvidence: { energy: { rating: 10 } } }), false)
  assert.equal(matcher.matches({ matchEvidence: { version: 1 } }), false)
})
