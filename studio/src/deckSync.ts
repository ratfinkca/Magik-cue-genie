import type { DeckId } from "./transitionAudio"

export type SyncDeck = {
  bpm?: number | null
  speed: number
  position: number
  beats?: readonly number[]
  duration?: number
}

export type FollowIssue = "missing-tempo" | "speed-out-of-range"
type TempoMatch = { ok: true; speed: number; effectiveBpm: number }
type FailedMatch = { ok: false; reason: FollowIssue }
export type SyncResult = (TempoMatch & { position: number | null }) | FailedMatch

export type DeckSyncInput = { track: object | null; bpm: number | null; speed: number; loading?: boolean }
export type DeckSyncPair = Record<DeckId, DeckSyncInput>
export type DeckFollowLink = { follower: DeckId; trackA: object; trackB: object }

export type TapSyncState = { taps: readonly number[]; bpm: number | null }

const shortestTapMs = 250
const longestTapMs = 2_000
const tapWindow = 8

function validTempo(bpm?: number | null): bpm is number {
  return typeof bpm === "number" && Number.isFinite(bpm) && bpm > 0
}

function beatInterval(beats: readonly number[], index: number, nominalPeriod: number) {
  const start = beats[index]
  const period = beats[index + 1] - start
  if (!Number.isFinite(start) || !(period > 0) || Math.abs(period - nominalPeriod) > nominalPeriod * .22) return null
  return { start, period }
}

function intervalAt(beats: readonly number[], position: number): number | null {
  if (!Number.isFinite(position) || beats.length < 2 || position < beats[0] || position > beats[beats.length - 1]) return null
  let left = 0
  let right = beats.length - 1
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2)
    if (beats[middle] <= position) left = middle
    else right = middle
  }
  return left
}

function observedPhase(deck: SyncDeck) {
  if (!validTempo(deck.bpm) || !deck.beats) return null
  const index = intervalAt(deck.beats, deck.position)
  const interval = index === null ? null : beatInterval(deck.beats, index, 60 / deck.bpm)
  if (!interval) return null
  return ((deck.position - interval.start) / interval.period) % 1
}

function nearestPhasePosition(deck: SyncDeck, phase: number | null): number | null {
  if (!validTempo(deck.bpm) || !deck.beats || phase === null) return null
  const current = intervalAt(deck.beats, deck.position)
  if (current === null) return null
  const nominalPeriod = 60 / deck.bpm
  const interval = beatInterval(deck.beats, current, nominalPeriod)
  if (!interval) return null

  let nearest: number | null = null
  let distance = interval.period / 2 + 1e-9
  const end = deck.duration === undefined ? Infinity : deck.duration - .001
  // A nearby occurrence can fall in the previous or next observed beat interval.
  for (const index of [current, current - 1, current + 1]) {
    const candidate = beatInterval(deck.beats, index, nominalPeriod)
    if (!candidate) continue
    const position = candidate.start + phase * candidate.period
    const difference = Math.abs(position - deck.position)
    if (position >= 0 && position < end && difference < distance) {
      nearest = position
      distance = difference
    }
  }
  return nearest
}

function matchTempo(targetBpm: number | null | undefined, effectiveBpm: number | null): TempoMatch | FailedMatch {
  if (!validTempo(targetBpm) || !validTempo(effectiveBpm)) return { ok: false, reason: "missing-tempo" }
  const speed = effectiveBpm * 100 / targetBpm
  if (speed < 50 || speed > 200) return { ok: false, reason: "speed-out-of-range" }
  return { ok: true, speed, effectiveBpm }
}

function effectiveDeckBpm({ bpm, speed }: Pick<SyncDeck, "bpm" | "speed">) {
  return validTempo(bpm) ? bpm * speed / 100 : null
}

/** Match the other deck's current effective BPM and, when supported, beat phase. */
export function matchDeckSync(target: SyncDeck, reference: SyncDeck): SyncResult {
  const result = matchTempo(target.bpm, effectiveDeckBpm(reference))
  return result.ok ? { ...result, position: nearestPhasePosition(target, observedPhase(reference)) } : result
}

export function makeDeckFollow(follower: DeckId, decks: DeckSyncPair): DeckFollowLink | null {
  return decks.A.track && decks.B.track ? { follower, trackA: decks.A.track, trackB: decks.B.track } : null
}

/** Reconcile a linked pair using rates only. Replacement clears the link. */
export function getDeckFollowUpdate(link: DeckFollowLink, decks: DeckSyncPair): {
  follower: DeckId; speed: number | null; issue: FollowIssue | null
} | null {
  if (link.trackA !== decks.A.track || link.trackB !== decks.B.track) return null
  const { follower } = link
  const target = decks[follower]
  const reference = decks[follower === "A" ? "B" : "A"]
  if (target.loading || reference.loading) return { follower, speed: null, issue: null }
  const match = matchTempo(target.bpm, effectiveDeckBpm(reference))
  if (!match.ok) return { follower, speed: null, issue: match.reason }
  const speed = Math.abs(target.speed - match.speed) < 1e-6 ? null : match.speed
  return { follower, speed, issue: null }
}

/** Retain the last eight taps and take the median of consecutive intervals. */
export function recordSyncTap(previous: TapSyncState | null, nowMs: number): TapSyncState {
  if (!Number.isFinite(nowMs) || nowMs < 0) return { taps: [], bpm: null }
  const history = previous?.taps ?? []
  const elapsed = nowMs - (history.at(-1) ?? -Infinity)
  if (elapsed < shortestTapMs || elapsed > longestTapMs) return { taps: [nowMs], bpm: null }
  const taps = [...history.slice(-(tapWindow - 1)), nowMs]
  if (taps.length < 3) return { taps, bpm: null }

  const intervals = taps.slice(1).map((time, index) => time - taps[index]).sort((a, b) => a - b)
  const median = (intervals[Math.floor((intervals.length - 1) / 2)] + intervals[Math.floor(intervals.length / 2)]) / 2
  return { taps, bpm: 60_000 / median }
}

export function matchTapSync(target: SyncDeck, tap: TapSyncState | null, nowMs: number): SyncResult {
  if (!validTempo(tap?.bpm)) return { ok: false, reason: "missing-tempo" }
  const elapsed = nowMs - (tap.taps.at(-1) ?? -Infinity)
  const phase = elapsed >= 0 && elapsed <= longestTapMs ? (elapsed / (60_000 / tap.bpm)) % 1 : null
  const result = matchTempo(target.bpm, tap.bpm)
  return result.ok ? { ...result, position: nearestPhasePosition(target, phase) } : result
}

/** Apply the first estimate with phase, then update tempo while the same tap sequence continues. */
export function tapDeckSync(target: SyncDeck, previous: TapSyncState | null, nowMs: number): {
  tap: TapSyncState; result: SyncResult | null
} {
  const tap = recordSyncTap(previous, nowMs)
  if (tap.bpm === null) return { tap, result: null }
  if (previous?.bpm == null) return { tap, result: matchTapSync(target, tap, nowMs) }

  const tempo = matchTempo(target.bpm, tap.bpm)
  return { tap, result: tempo.ok ? { ...tempo, position: null } : tempo }
}
