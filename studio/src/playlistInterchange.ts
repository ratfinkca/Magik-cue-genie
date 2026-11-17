import type { InterchangeLibrary } from "./interchangeTypes"

export const MAX_INTERCHANGE_BYTES = 12 * 1024 * 1024
const MAX_PLAYLIST_ENTRIES = 10_000

/** Resolve a reference as text for matching. The toolkit never opens a path from an import. */
export function localMediaPath(reference: string): string | null {
  let path = reference.trim().replace(/^"(.*)"$/, "$1")
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== "localhost" || url.search || url.hash) return null
      path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, "$1")
    } catch { return null }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null
  path = path.replaceAll("\\", "/")
  if (!path || path.startsWith("//") || /[\u0000-\u001f\u007f]/.test(path)) return null
  return path
}

export function decodeM3u(text: string, name: string): InterchangeLibrary {
  if (text.includes("\0") || /^#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|MAP)\b/im.test(text)) {
    throw new Error("Choose a local audio playlist in M3U or M3U8 format.")
  }
  const tracks = new Map<string, InterchangeLibrary["tracks"][number]>()
  const trackIds: string[] = []
  let description: { title: string; durationSeconds?: number } | undefined
  let ignored = 0
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n?|\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("#")) {
      const info = /^#EXTINF:([^,]+),(.*)$/i.exec(line)
      if (info) {
        const length = Number(info[1])
        description = { title: info[2].trim(), durationSeconds: Number.isFinite(length) && length > 0 ? length : undefined }
      }
      continue
    }
    const path = localMediaPath(line)
    if (!path) { ignored++; description = undefined; continue }
    if (trackIds.length >= MAX_PLAYLIST_ENTRIES) throw new RangeError("Choose a playlist with up to 10,000 entries.")
    let track = tracks.get(path)
    if (!track) {
      track = { id: "m3u-" + (tracks.size + 1), location: path,
        title: description?.title || path.split("/").at(-1) || path, durationSeconds: description?.durationSeconds }
      tracks.set(path, track)
    }
    trackIds.push(track.id)
    description = undefined
  }
  if (!trackIds.length) throw new Error("This playlist has no local audio references.")
  const duplicates = trackIds.length - tracks.size
  return { tracks: [...tracks.values()], playlists: [{ name, trackIds }], warnings: [
    ...(ignored ? [`Skipped ${ignored} unsupported media references.`] : []),
    ...(duplicates ? [`Cue Studio playlists keep the first occurrence of each track. ${duplicates} repeated entries may be collapsed.`] : []),
  ] }
}

export function encodeM3u(tracks: readonly { location: string; title: string; durationSeconds?: number }[]): string {
  const lines = ["#EXTM3U"]
  for (const track of tracks) {
    const path = localMediaPath(track.location)
    if (!path || path.startsWith("#")) throw new Error("A track has an invalid playlist path.")
    const duration = track.durationSeconds
    const seconds = duration !== undefined && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : -1
    lines.push(`#EXTINF:${seconds},${track.title.replace(/[\u0000-\u001f\u007f]/g, " ")}`, path)
  }
  return lines.join("\n") + "\n"
}

type MatchableTrack = { id: string; fileName: string; relativePath?: string; relativePaths?: string[]; needsAudio?: true }
export function libraryMediaMatcher<T extends MatchableTrack>(library: readonly T[]) {
  const byFilename = new Map<string, Set<T>>()
  const byPathSuffix = new Map<string, Set<T>>()
  function add(index: Map<string, Set<T>>, key: string, item: T) {
    let entries = index.get(key)
    if (!entries) index.set(key, entries = new Set())
    entries.add(item)
  }
  function segments(path: string) {
    return path.normalize("NFC").toLowerCase().split("/").filter(segment => segment && segment !== ".")
  }
  for (const track of library) {
    if (track.needsAudio) continue
    add(byFilename, track.fileName.normalize("NFC").toLowerCase(), track)
    for (const relative of new Set([...(track.relativePaths ?? []), track.relativePath ?? ""])) {
      const parts = segments(relative)
      for (let index = 0; index < parts.length - 1; index++) add(byPathSuffix, parts.slice(index).join("/"), track)
    }
  }
  return (reference: string) => {
    const path = localMediaPath(reference)
    const parts = path ? segments(path) : []
    const filename = parts.at(-1)
    const candidates = filename ? [...(byFilename.get(filename) ?? [])] : []
    if (parts.includes("..")) return { match: null, candidates }
    for (let index = 0; index < parts.length - 1; index++) {
      const exact = byPathSuffix.get(parts.slice(index).join("/"))
      if (!exact?.size) continue
      return { match: exact.size === 1 ? [...exact][0] : null, candidates: [...exact] }
    }
    return { match: null, candidates }
  }
}
