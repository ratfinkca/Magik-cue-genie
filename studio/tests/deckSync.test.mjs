import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/deckSync.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { matchDeckSync, matchTapSync, recordSyncTap, makeDeckFollow, getDeckFollowUpdate, tapDeckSync } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const target = { bpm: 100, speed: 80, position: 1.84, beats: [.15, .75, 1.35, 1.95, 2.55] }
const reference = { bpm: 120, speed: 110, position: 1.325, beats: [.2, .7, 1.2, 1.7, 2.2] }

test('matches the playing reference tempo and seeks to its nearest fractional beat phase', () => {
  const result = matchDeckSync(target, reference)
  assert.equal(result.ok, true)
  assert.equal(result.speed, 132)
  assert.equal(result.effectiveBpm, 132)
  assert.ok(Math.abs(result.position - 2.1) < .00001)
})

test('uses the current deck tempo even when phase evidence is unavailable', () => {
  const tempoOnly = { ok: true, speed: 132, effectiveBpm: 132, position: null }
  assert.deepEqual(matchDeckSync({ ...target, beats: [] }, reference), tempoOnly)
  assert.deepEqual(matchDeckSync(target, { ...reference, position: .15 }), tempoOnly)
  assert.deepEqual(matchDeckSync(target, { ...reference, beats: [.2, .7, 1.7, 2.2] }), tempoOnly)
  assert.deepEqual(matchDeckSync({ ...target, beats: [.15, .75, 1.35, 2.55] }, reference), tempoOnly)
})

test('does not skip through a gap or seek beyond the supported track ending', () => {
  const tempoOnly = { ok: true, speed: 132, effectiveBpm: 132, position: null }
  assert.deepEqual(matchDeckSync({ ...target, beats: [.15, .75, 1.35, 1.95, 3.15] }, reference), tempoOnly)
  assert.deepEqual(matchDeckSync({ ...target, duration: 2.1 }, reference), tempoOnly)
})

test('rejects missing BPM and a match outside the playable speed range', () => {
  assert.deepEqual(matchDeckSync({ ...target, bpm: null }, reference), { ok: false, reason: 'missing-tempo' })
  assert.deepEqual(matchDeckSync(target, { ...reference, bpm: 240 }), { ok: false, reason: 'speed-out-of-range' })
  assert.deepEqual(matchDeckSync(target, { ...reference, bpm: 30 }), { ok: false, reason: 'speed-out-of-range' })
})

test('requires three taps and uses the median interval despite one late tap', () => {
  const afterTwo = [100, 600].reduce(recordSyncTap, null)
  assert.equal(afterTwo.bpm, null)
  assert.equal([100, 600, 1300, 1800].reduce(recordSyncTap, null).bpm, 120)
})

test('starts a new tap sequence after delays, implausibly close taps or backward timestamps', () => {
  const previous = [100, 600, 1100].reduce(recordSyncTap, null)
  for (const now of [900, 1130, 3101]) {
    assert.deepEqual(recordSyncTap(previous, now), { taps: [now], bpm: null })
  }
})

test('uses the last tap as a phase origin while fresh and retains its BPM when stale', () => {
  const tap = [100, 600, 1300, 1800].reduce(recordSyncTap, null)
  const fresh = matchTapSync(target, tap, 1925)
  assert.equal(fresh.ok, true)
  assert.equal(fresh.speed, 120)
  assert.ok(Math.abs(fresh.position - 2.1) < .00001)
  assert.deepEqual(matchTapSync(target, tap, 3900), { ok: true, speed: 120, effectiveBpm: 120, position: null })
  assert.deepEqual(matchTapSync({ ...target, bpm: null }, tap, 1925), { ok: false, reason: 'missing-tempo' })
})

test('deck taps align phase once and refine speed without seeking on subsequent taps', () => {
  const first = tapDeckSync(target, null, 0)
  const second = tapDeckSync(target, first.tap, 400)
  assert.equal(second.result, null)

  const third = tapDeckSync(target, second.tap, 1000)
  assert.deepEqual(third.result, { ok: true, speed: 120, effectiveBpm: 120, position: 1.95 })
  const next = tapDeckSync(target, third.tap, 1620)
  assert.deepEqual(next.result, { ok: true, speed: 100, effectiveBpm: 100, position: null })

  const reset = tapDeckSync(target, next.tap, 4000)
  assert.deepEqual(reset, { tap: { taps: [4000], bpm: null }, result: null })
  const reestablished = tapDeckSync(target, tapDeckSync(target, reset.tap, 4500).tap, 5000)
  assert.equal(reestablished.result.position, 1.95)
})

test('deck taps give a usable estimate even when the track lacks an original BPM', () => {
  const unmeasuredTrack = { ...target, bpm: null }
  const previous = [500, 1000].reduce(recordSyncTap, null)
  assert.deepEqual(tapDeckSync(unmeasuredTrack, previous, 1500), {
    tap: { taps: [500, 1000, 1500], bpm: 120 }, result: { ok: false, reason: 'missing-tempo' },
  })
})

test('a live link follows the reference rate with tempo only and skips unchanged rates', () => {
  const decks = { A: { track: {}, bpm: 100, speed: 120 }, B: { track: {}, bpm: 120, speed: 100 } }
  const link = makeDeckFollow('A', decks)
  assert.deepEqual(getDeckFollowUpdate(link, decks), { follower: 'A', speed: null, issue: null })
  const faster = { ...decks, B: { ...decks.B, speed: 110 } }
  assert.deepEqual(getDeckFollowUpdate(link, faster), { follower: 'A', speed: 132, issue: null })
  assert.deepEqual(getDeckFollowUpdate(makeDeckFollow('B', faster), faster),
    { follower: 'B', speed: 100, issue: null })
})

test('a live link ends when either track object is replaced', () => {
  const decks = { A: { track: {}, bpm: 100, speed: 120 }, B: { track: {}, bpm: 120, speed: 100 } }
  const link = makeDeckFollow('A', decks)
  for (const id of ['A', 'B']) {
    assert.equal(getDeckFollowUpdate(link, { ...decks, [id]: { ...decks[id], track: {} } }), null)
  }
  assert.equal(makeDeckFollow('A', { ...decks, B: { ...decks.B, track: null } }), null)
})

test('a live link leaves a rate outside the supported range unapplied and can resume', () => {
  const decks = { A: { track: {}, bpm: 100, speed: 150 }, B: { track: {}, bpm: 150, speed: 100 } }
  const link = makeDeckFollow('A', decks)
  assert.deepEqual(getDeckFollowUpdate(link, { ...decks, B: { ...decks.B, speed: 150 } }),
    { follower: 'A', speed: null, issue: 'speed-out-of-range' })
  assert.deepEqual(getDeckFollowUpdate(link, { ...decks, B: { ...decks.B, speed: 110 } }),
    { follower: 'A', speed: 165, issue: null })
})
