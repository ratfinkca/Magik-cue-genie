import type { Cue } from "./cues"

export function cueIdentity(cue: Cue | undefined): string | undefined {
  const id = cue?.metadata?.studio_id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

export function identifyCues(cues: Cue[]): Cue[] {
  const seen = new Set<string>()
  return cues.map((cue, index) => {
    const existing = cueIdentity(cue)
    if (existing && !seen.has(existing)) {
      seen.add(existing)
      return cue
    }
    let id = `studio-cue:${index}:${cue.time_seconds}:${cue.label}`
    while (seen.has(id)) id += ":"
    seen.add(id)
    return { ...cue, metadata: { ...cue.metadata, studio_id: id } }
  })
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

function restoreMetadata(current: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>) {
  const entries = Object.entries(current).filter(([key]) => !(Object.hasOwn(after, key) && !Object.hasOwn(before, key)
    && sameValue(current[key], after[key])))
  const next = new Map(entries)
  for (const [key, original] of Object.entries(before)) {
    if (sameValue(original, after[key])) continue
    if (sameValue(current[key], after[key])) next.set(key, original)
    else if (key === "loop" && object(current[key]) && object(original) && object(after[key])) {
      next.set(key, restoreMetadata(current[key], original, after[key]))
    }
  }
  return Object.fromEntries(next)
}

/** Undo this editor’s change against the latest track cues, leaving newer edits intact. */
export function restoreCueEdits(current: Cue[], before: Cue[], after: Cue[]): Cue[] {
  const beforeById = new Map(before.map(cue => [cueIdentity(cue), cue]))
  const afterById = new Map(after.map(cue => [cueIdentity(cue), cue]))
  const next = current.flatMap(cue => {
    const id = cueIdentity(cue)
    const old = beforeById.get(id)
    const applied = afterById.get(id)
    if (!applied) return [cue]
    if (!old) return sameValue(cue, applied) ? [] : [cue]
    if (old === applied) return [cue]
    const restored = { ...cue }
    for (const field of ["label", "time_seconds", "confidence", "reason"] as const) {
      if (!sameValue(old[field], applied[field]) && sameValue(cue[field], applied[field])) {
        Object.assign(restored, { [field]: old[field] })
      }
    }
    if (!sameValue(old.metadata, applied.metadata)) {
      if (sameValue(cue.metadata, applied.metadata)) restored.metadata = old.metadata
      else if (cue.metadata && old.metadata && applied.metadata) {
        restored.metadata = restoreMetadata(cue.metadata, old.metadata, applied.metadata)
      }
    }
    return [sameValue(restored, old) ? old : sameValue(restored, cue) ? cue : restored]
  })
  for (const [index, cue] of before.entries()) {
    const id = cueIdentity(cue)
    if (afterById.has(id) || next.some(item => cueIdentity(item) === id)) continue
    const following = before.slice(index + 1).map(cueIdentity)
    const insertAt = next.findIndex(item => following.includes(cueIdentity(item)))
    next.splice(insertAt < 0 ? next.length : insertAt, 0, cue)
  }
  const currentById = new Map(next.map(cue => [cueIdentity(cue), cue]))
  const common = (cue: Cue) => {
    const id = cueIdentity(cue)
    return beforeById.has(id) && afterById.has(id) && currentById.has(id)
  }
  const beforeOrder = before.filter(common).map(cueIdentity)
  const afterOrder = after.filter(common).map(cueIdentity)
  if (sameValue(beforeOrder, afterOrder) || !sameValue(next.filter(common).map(cueIdentity), afterOrder)) return next
  let cursor = 0
  return next.map(cue => common(cue) ? currentById.get(beforeOrder[cursor++]) ?? cue : cue)
}
