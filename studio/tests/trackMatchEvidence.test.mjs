import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/trackMatchEvidence.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { readTrackMatchEvidence } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

function prep(analysis = {}, cues = []) {
  return { schema_version: 1, source_file: "synthetic.wav", analysis, cues, warnings: [] }
}

test("energy distinguishes equal envelope shapes at different absolute levels", () => {
  const normalized_envelope = [1, .75, .8, .67, .72, .78, .61, .55]
  const quiet = readTrackMatchEvidence(prep({ energy_summary: { mean_rms: .017, max_rms: .025, normalized_envelope } })).energy
  const loud = readTrackMatchEvidence(prep({ energy_summary: { mean_rms: .29, max_rms: .42, normalized_envelope } })).energy
  assert.ok(quiet.rating <= 4)
  assert.ok(loud.rating >= 8 && loud.rating <= 10)
  assert.ok(loud.rmsDb > quiet.rmsDb)
  assert.ok(loud.activity > quiet.activity)
  assert.equal(loud.dynamicRangeDb, quiet.dynamicRangeDb)
})

test("missing or silent energy and predicted-only grids leave unknown evidence absent", () => {
  const predicted = { status: "predicted", beat_times_seconds: Array.from({ length: 240 }, (_, index) => index / 2) }
  assert.deepEqual(readTrackMatchEvidence(prep({
    duration_seconds: 120, estimated_bpm: 120, studio_model_grid: predicted,
    energy_summary: { mean_rms: 0, max_rms: 0, normalized_envelope: [0, 0] },
  })), { version: 1 })
})

test("reviewed windows win over rhythm estimates and are validated in track time", () => {
  const cue = (label, time_seconds, window_beats) => ({
    label, time_seconds, metadata: { phrase_verified: true, window_beats },
  })
  const { phrasing } = readTrackMatchEvidence(prep({ duration_seconds: 120, estimated_bpm: 120 }, [
    cue("Mix in", -4, 32), cue("Mix in", 4, 16), cue("Mix out", 116, 32),
  ]))
  assert.deepEqual(phrasing, { intro: { start: 4, beats: 16, source: "verified", regularity: 1 } })
})

test("measured rehearsal windows stay labeled estimates and stop at sparse rhythm", () => {
  const first = Array.from({ length: 40 }, (_, index) => .5 + index * .5)
  const late = Array.from({ length: 42 }, (_, index) => 99 + index * .5)
  const analysis = {
    duration_seconds: 120,
    studio_beatgrid: {
      status: "estimated", source: "studio_onset_consensus", evidence: { period_seconds: .5 },
      beat_times_seconds: [...first, ...late],
    },
  }
  const cue = { label: "Mix in", time_seconds: 1, metadata: { heuristic: "kick_supported_mix_window", window_beats: 32 } }
  const { phrasing } = readTrackMatchEvidence(prep(analysis, [cue]))
  assert.deepEqual(phrasing.intro, { start: 1, beats: 32, source: "measured", regularity: 1 })
  assert.ok(phrasing.outro.start >= 99 && phrasing.outro.start + 16 <= 120)
  assert.equal(phrasing.outro.source, "measured")
  analysis.studio_beatgrid.beat_times_seconds = [1, 3, 5, 8, 10, 12, 16, 18, 21, 23, 25, 28, 30, 95, 100, 103, 109]
  assert.equal(readTrackMatchEvidence(prep(analysis, [cue])).phrasing, undefined)
  analysis.studio_beatgrid.beat_times_seconds = [...first, 20.001, ...late]
  assert.equal(readTrackMatchEvidence(prep(analysis)).phrasing, undefined)
})
