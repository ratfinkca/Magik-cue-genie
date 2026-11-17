import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

async function moduleUrl(file, trackTimeUrl) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8')
  const resolved = trackTimeUrl ? source.replace('"./trackTime"', JSON.stringify(trackTimeUrl)) : source
  const javascript = ts.transpileModule(resolved, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

const trackTimeUrl = await moduleUrl('trackTime')
const { clampTrackTime, MIN_TRACK_SECONDS } = await import(trackTimeUrl)
const { formatTime, readSidecar, readStudioAnalysis } = await import(await moduleUrl('cues', trackTimeUrl))

test('a malformed local suggestion preserves the other cue and the analyzed grid', () => {
  const validCue = { label: 'First pulse', time_seconds: .25, confidence: .8, reason: 'Observed transient' }
  const data = {
    schema_version: 1, source_file: 'generated.wav', warnings: [],
    cues: [validCue, { ...validCue, time_seconds: 60 }],
    analysis: {
      duration_seconds: 48, estimated_key: '8A', estimated_bpm: 120,
      studio_beatgrid: { status: 'estimated', beat_times_seconds: [.25, .75] },
      studio_cues: { status: 'ready', rhythm_status: 'ready', count: 2 },
    },
  }
  const parsed = readStudioAnalysis(data, 'generated.wav', 48)
  assert.equal(parsed.cues.length, 1)
  assert.equal(parsed.cues[0].time_seconds, .25)
  assert.equal(parsed.analysis.estimated_key, '8A')
  assert.equal(parsed.analysis.estimated_bpm, 120)
  assert.deepEqual(parsed.analysis.studio_beatgrid.beat_times_seconds, [.25, .75])
  assert.deepEqual(parsed.analysis.studio_cues, { status: 'partial', rhythm_status: 'ready', count: 1 })
  assert.throws(() => readSidecar(JSON.stringify(data), 'generated.wav', 48), /invalid label, timestamp, or confidence/)
})

test('a missing local cue payload is reported separately from valid track data', () => {
  const data = { schema_version: 1, source_file: 'generated.wav', analysis: { duration_seconds: 48 }, warnings: [] }
  const parsed = readStudioAnalysis(data, 'generated.wav', 48)
  assert.deepEqual(parsed.cues, [])
  assert.equal(parsed.analysis.duration_seconds, 48)
  assert.equal(parsed.analysis.studio_cues.status, 'error')
})
const { leadInSeconds, leadInTime, leadInTrackSeconds } = await import(await moduleUrl('leadIn', trackTimeUrl))
const { quantizeTime } = await import(await moduleUrl('quantize'))
const { getLoop } = await import(await moduleUrl('loops'))

test('a 16-bar lead-in before the start previews at a signed, unsnapped -32 seconds', () => {
  const cue = leadInTime(0, leadInSeconds('bars', 16, 120, 4))
  assert.equal(cue, -32)
  assert.equal(quantizeTime(cue, [0, 0.5, 1, 1.5], 'quarter'), -32)
  assert.equal(formatTime(cue, true), '-00:32.000')
  assert.equal(formatTime(-90.25, true), '-01:30.250')
  assert.equal(formatTime(90.25, true), '01:30.250')
  assert.equal(formatTime(0, true), '00:00.000')
})

test('pre-roll cues preserve signed time and linked metadata in a Studio JSON round trip', () => {
  const marker = {
    label: 'Lead-in · Cue 1', time_seconds: -31.75, confidence: 1, reason: 'Marked in Studio',
    metadata: { lead_in: { target_id: 'cue-1', amount: 16, unit: 'bars', bpm: 120, beats_per_bar: 4 } },
  }
  const payload = {
    schema_version: 1, source_file: 'generated.wav', analysis: { duration_seconds: 48 },
    warnings: [], cues: [marker],
  }
  const parsed = readSidecar(JSON.stringify(payload), 'generated.wav', 48)
  assert.deepEqual(parsed, payload)
  assert.deepEqual(readSidecar(JSON.stringify(parsed), 'generated.wav', 48), payload)
  assert.throws(() => readSidecar(JSON.stringify({ ...payload, cues: [{ ...marker, time_seconds: MIN_TRACK_SECONDS - 1 }] }),
    'generated.wav', 48), /invalid.+timestamp/)
})

test('timestamps are bounded and a pre-roll marker cannot act as a loop start', () => {
  assert.equal(clampTrackTime(-15, 48), -15)
  assert.equal(clampTrackTime(-700, 48), MIN_TRACK_SECONDS)
  assert.equal(leadInTime(0, -MIN_TRACK_SECONDS), MIN_TRACK_SECONDS)
  assert.equal(leadInTime(-1, -MIN_TRACK_SECONDS), null)
  const marker = { time_seconds: -0.25, metadata: { loop: { kind: 'manual', active: true, end_seconds: 1 } } }
  assert.equal(getLoop(marker, 48), null)
  assert.deepEqual(getLoop({ ...marker, time_seconds: 0 }, 48), marker.metadata.loop)
})

test('the adjusted BPM and an explicit match tempo produce the intended audible beat count', () => {
  const rate = 1.25
  const nativeBars = leadInTrackSeconds('bars', 16, 120, 4, rate)
  assert.equal(nativeBars, 32)
  assert.equal(nativeBars / rate, 64 * 60 / 150)
  const matchedBars = leadInTrackSeconds('bars', 16, 120, 4, rate, 128)
  assert.equal(matchedBars, 37.5)
  assert.equal(matchedBars / rate, 30)
  assert.equal(leadInTrackSeconds('seconds', 10, 120, 4, rate, 128), 10)
})
