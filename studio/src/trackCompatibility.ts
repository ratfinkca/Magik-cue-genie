import type { LibraryTrack } from "./trackLibrary"

export type TrackMatchLevel = "close" | "possible" | "distant" | "limited"
export type TrackCompatibility = { score: number | null; level: TrackMatchLevel; compared: number; detail: string }
type Factor = { score: number; weight: number; description: string }

const clampUnit = (value: number) => Math.max(0, Math.min(1, value))
const bpmIsUsable = (bpm: number | undefined): bpm is number => typeof bpm === "number" && bpm >= 20 && bpm <= 400

function tempoFactor(outgoing: number | undefined, incoming: number | undefined): Factor | undefined {
  if (!bpmIsUsable(outgoing) || !bpmIsUsable(incoming)) return undefined
  const choices = [1, .5, 2].map(multiplier => {
    const adjustment = (outgoing / (incoming * multiplier) - 1) * 100
    const distance = Math.abs(adjustment) + (multiplier === 1 ? 0 : 1.5)
    return { multiplier, adjustment, distance }
  })
  const { multiplier, adjustment, distance } = choices.reduce((best, choice) => choice.distance < best.distance ? choice : best)
  const shift = (adjustment >= 0 ? "+" : "−") + Math.abs(adjustment).toFixed(1) + "%"
  const interpretation = multiplier === 2 ? " at double time" : multiplier === .5 ? " at half time" : ""
  return { score: 100 * clampUnit(1 - distance / 12), weight: .4, description: "Tempo " + shift + interpretation }
}

function genreTokens(genre: string): string[] {
  return [...new Set(genre.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u).filter(word => word && word !== "and" && word !== "music"))]
}

function genreFactor(outgoing?: string[], incoming?: string[]): Factor | undefined {
  const left = outgoing?.map(genreTokens).filter(terms => terms.length)
  const right = incoming?.map(genreTokens).filter(terms => terms.length)
  if (!left?.length || !right?.length) return undefined
  let score = 0
  for (const a of left) for (const b of right) {
    const shared = a.filter(token => b.includes(token)).length
    const union = a.length + b.length - shared
    score = Math.max(score, shared === union ? 100 : 84 * shared / union)
  }
  return { score, weight: .24, description: score === 100 ? "Shared genre tag" : score > 0 ? "Related genre tags" : "Different genre tags" }
}

function energyFactor(outgoing: number | undefined, incoming: number | undefined): Factor | undefined {
  if (outgoing === undefined || incoming === undefined || !Number.isInteger(outgoing) || !Number.isInteger(incoming)
    || outgoing < 1 || outgoing > 10 || incoming < 1 || incoming > 10) return undefined
  return { score: 100 * clampUnit(1 - Math.abs(outgoing - incoming) / 6), weight: .2,
    description: `Estimated energy ${outgoing} → ${incoming}` }
}

function phrasingFactor(outgoing: LibraryTrack, incoming: LibraryTrack): Factor | undefined {
  const outro = outgoing.matchEvidence?.phrasing?.outro
  const intro = incoming.matchEvidence?.phrasing?.intro
  if (!outro || !intro) return undefined
  const sharedBeats = Math.min(outro.beats, intro.beats)
  const support = Math.min(outro.regularity, intro.regularity)
  if (!Number.isFinite(sharedBeats) || sharedBeats < 4 || !Number.isFinite(support)) return undefined
  const lengthScore = clampUnit(Math.log2(sharedBeats / 4) / 3)
  const reliability = .55 + .45 * clampUnit(support)
  const estimated = outro.source !== "verified" || intro.source !== "verified"
  return { score: 100 * lengthScore * reliability, weight: .16,
    description: `${sharedBeats}-beat ${estimated ? "estimated " : ""}outro/intro overlap` }
}

export function compareTrackCompatibility(reference: LibraryTrack, candidate: LibraryTrack): TrackCompatibility {
  const tempo = tempoFactor(reference.bpm, candidate.bpm)
  const factors = [tempo, genreFactor(reference.genres, candidate.genres),
    energyFactor(reference.matchEvidence?.energy?.rating, candidate.matchEvidence?.energy?.rating),
    phrasingFactor(reference, candidate)].filter((factor): factor is Factor => factor !== undefined)
  const compared = factors.length
  const detail = [`${compared} of 4 factors`, ...factors.map(factor => factor.description)].join(" · ")
  if (compared < 2) return { score: null, level: "limited", compared, detail }
  const score = Math.round(factors.reduce((total, factor) => total + factor.score * factor.weight, 0)
    / factors.reduce((total, factor) => total + factor.weight, 0))
  const level = score >= 80 && compared >= 3 && tempo && tempo.score >= 50 ? "close" : score >= 55 ? "possible" : "distant"
  return { score, level, compared, detail }
}
