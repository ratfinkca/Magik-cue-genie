import type { LibraryTrack } from "./trackLibrary"

export const LIBRARY_FILTER_FIELDS = {
  track: "Track", artist: "Artist", genre: "Genre", key: "Key", bpm: "BPM", duration: "Length", energy: "Energy", prepared: "Preparation",
} as const

export type LibraryFilterField = keyof typeof LIBRARY_FILTER_FIELDS
export type LibraryMatchMode = "all" | "any"
export type TextCondition = "contains" | "is" | "missing"

export type LibraryFilterRule = {
  id: number
  field: LibraryFilterField
  condition: TextCondition
  value: string
  maximum: string
}

export function newLibraryFilterRule(id: number, field: LibraryFilterField): LibraryFilterRule {
  return { id, field, condition: "contains", value: field === "prepared" ? "yes" : "", maximum: "" }
}

export function isNumericLibraryField(field: LibraryFilterField): field is "bpm" | "duration" | "energy" {
  return field === "bpm" || field === "duration" || field === "energy"
}

function textValues(track: LibraryTrack, field: Exclude<LibraryFilterField, "bpm" | "duration" | "energy" | "prepared">) {
  switch (field) {
    case "track": return [track.title, track.name, track.fileName]
    case "artist": return [track.artist]
    case "genre": return track.genres ?? []
    case "key": return [track.key]
  }
}

/** Compile active rules once so pagination and reordering keep the original scope and order. */
export function compileLibraryFilters(rules: readonly LibraryFilterRule[], mode: LibraryMatchMode) {
  const invalid = new Set<number>()
  const activeFields = new Set<LibraryFilterField>()
  const tests: ((track: LibraryTrack) => boolean)[] = []
  for (const rule of rules) {
    const { field, condition } = rule
    const value = rule.value.trim()
    const maximum = rule.maximum.trim()
    if (isNumericLibraryField(field)) {
      if (!value && !maximum) continue
      const low = value ? Number(value) : field === "energy" ? 1 : 0
      const high = maximum ? Number(maximum) : field === "energy" ? 10 : Infinity
      const invalidEnergy = field === "energy" && (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 10)
      if (invalidEnergy || !Number.isFinite(low) || low < 0 || (maximum && !Number.isFinite(high)) || low > high) {
        invalid.add(rule.id)
        continue
      }
      tests.push(track => {
        const measurement = field === "energy" ? track.matchEvidence?.energy?.rating : track[field]
        return typeof measurement === "number" && Number.isFinite(measurement) && measurement >= low && measurement <= high
      })
    } else if (field === "prepared") {
      tests.push(track => track.prepared === (value === "yes"))
    } else if (condition === "missing") {
      tests.push(track => !textValues(track, field).some(item => Boolean(item?.trim())))
    } else if (value) {
      const term = value.toLocaleLowerCase()
      tests.push(track => textValues(track, field).some(item => {
        const text = item?.trim().toLocaleLowerCase()
        return condition === "is" ? text === term : Boolean(text?.includes(term))
      }))
    } else continue
    activeFields.add(field)
  }
  return {
    count: tests.length, activeFields, invalid,
    matches(track: LibraryTrack) {
      return !tests.length || (mode === "all" ? tests.every(test => test(track)) : tests.some(test => test(track)))
    },
  }
}
