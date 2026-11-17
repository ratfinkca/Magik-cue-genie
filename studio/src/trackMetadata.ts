import type { TrackKey } from './key'

/** Tags are claims from the file, not calibrated analysis results. */
function taggedKey(pitchClass: number, mode: TrackKey['mode']): TrackKey {
  return { pitchClass, mode, confidence: 0, method: 'file-tag', analyzedWindows: 0 }
}

export function parseTaggedKey(value: unknown): TrackKey | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replaceAll('♯', '#').replaceAll('♭', 'b')
  const wheel = /^(1[0-2]|[1-9])([ABdm])$/i.exec(text)
  if (wheel) {
    const number = Number(wheel[1])
    const suffix = wheel[2].toLowerCase()
    const mode = suffix === 'a' || suffix === 'm' ? 'minor' : 'major'
    // Open Key 1d = C major / 1m = A minor; Camelot 8B / 8A.
    const openNumber = suffix === 'a' || suffix === 'b' ? ((number + 4) % 12) + 1 : number
    return taggedKey(((openNumber - 1) * 7 + (mode === 'minor' ? 9 : 0)) % 12, mode)
  }
  const note = /^([A-Ga-g])([#b]?)\s*(M|m|maj(?:or)?|min(?:or)?)?$/.exec(text)
  if (!note) return null
  const natural: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const accidental = note[2] === '#' ? 1 : note[2] === 'b' ? -1 : 0
  return taggedKey((natural[note[1].toUpperCase()] + accidental + 12) % 12,
    note[3] === 'm' || note[3]?.startsWith('min') ? 'minor' : 'major')
}

export function parseTaggedBpm(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null
  const bpm = Number(value)
  return Number.isFinite(bpm) && bpm > 0 ? bpm : null
}

/** Read only the selected browser File. No upload, decoding, or file writes. */
export async function readLibraryTrackMetadata(file: File): Promise<{
  key: TrackKey | null; bpm: number | null; title?: string; artist?: string; duration?: number; genres: string[]
}> {
  try {
    const { parseBlob } = await import('music-metadata')
    const metadata = await parseBlob(file, { skipCovers: true, duration: false })
    const keyValues: unknown[] = []
    const bpmValues: unknown[] = []
    for (const tags of Object.values(metadata.native)) {
      for (const tag of tags) {
        // Includes ID3 TXXX and MP4 ----:com.apple.iTunes:INITIALKEY.
        const name = tag.id.split(':').at(-1)?.replace(/[ _-]/g, '').toUpperCase()
        const values = Array.isArray(tag.value) ? tag.value : [tag.value]
        if (name && ['TKEY', 'TKE', 'KEY', 'INITIALKEY'].includes(name)) keyValues.push(...values)
        if (name && ['TBPM', 'TBP', 'BPM', 'TEMPO', 'TMPO', 'BEATSPERMINUTE'].includes(name)) bpmValues.push(...values)
      }
    }
    // Native BPM retains decimal precision and rejects malformed strings that
    // music-metadata's common BPM integer coercion would otherwise accept.
    const key = [...keyValues, metadata.common.key].map(parseTaggedKey).find(value => value !== null) ?? null
    const bpm = (bpmValues.length ? bpmValues : [metadata.common.bpm]).map(parseTaggedBpm).find(value => value !== null) ?? null
    const genres = new Map<string, string>()
    for (const tag of metadata.common.genre ?? []) {
      if (typeof tag !== 'string') continue
      const genre = tag.trim()
      const normalized = genre.toLocaleLowerCase()
      if (genre && !genres.has(normalized)) genres.set(normalized, genre)
    }
    return {
      key, bpm, title: metadata.common.title?.trim() || undefined, artist: metadata.common.artist?.trim() || undefined,
      duration: Number.isFinite(metadata.format.duration) ? metadata.format.duration : undefined,
      genres: [...genres.values()],
    }
  } catch {
    return { key: null, bpm: null, genres: [] }
  }
}

export async function readTrackMetadata(file: File): Promise<{ key: TrackKey | null; bpm: number | null }> {
  const { key, bpm } = await readLibraryTrackMetadata(file)
  return { key, bpm }
}
