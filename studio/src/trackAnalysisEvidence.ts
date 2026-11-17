import type { TrackKey } from "./key"
import { parseTaggedKey } from "./trackMetadata"

type TempoSource = "beat_grid" | "file_tag" | "estimate"
type TempoReading = { bpm: number; source: TempoSource } | { bpm: null; source: null }

export function usableBpm(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 20 && value <= 400
}

export function readDeckTempo(analysis: Record<string, unknown> | undefined, fileBpm: number | null,
  hasGrid: boolean): TempoReading {
  const bpm = analysis?.estimated_bpm
  const tagged = analysis?.estimated_bpm_source === "file_tag"
  if (hasGrid && usableBpm(bpm) && !tagged) return { bpm, source: "beat_grid" }
  if (usableBpm(fileBpm)) return { bpm: fileBpm, source: "file_tag" }
  if (usableBpm(bpm)) return { bpm, source: tagged ? "file_tag" : "estimate" }
  return { bpm: null, source: null }
}

export function readDeckKey(analysis: Record<string, unknown> | null | undefined, fileKey: TrackKey | null,
  estimate: TrackKey | null | undefined): TrackKey | null {
  if (fileKey) return fileKey
  const saved = parseTaggedKey(analysis?.estimated_key)
  if (saved && analysis?.studio_key_source === "file_tag") return saved
  if (estimate) return estimate
  return saved ? { ...saved, method: "saved-estimate" } : null
}
