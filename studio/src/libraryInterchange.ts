import { readBeatTimes, readManualBeatGrid } from "./beatGrid"
import { cueColor } from "./cues"
import type { Cue, Sidecar } from "./cues"
import type { InterchangeLibrary, InterchangeTempo, InterchangeTrack } from "./interchangeTypes"
import { isAudioFile, addLibraryFile, importMissingTrackPrep, openLibraryFile, readTrackPrep } from "./trackLibrary"
import { createTrackPlaylist, readTrackPlaylists } from "./trackPlaylist"
import type { TrackPlaylist } from "./trackPlaylist"
import { getLoop } from "./loops"
import { decodeM3u, encodeM3u, MAX_INTERCHANGE_BYTES } from "./playlistInterchange"
import { decodeRekordboxXml, encodeRekordboxXml } from "./rekordboxXml"
import type { DecodeForPreparation } from "./libraryPreparation"

export type MediaAssignment = { libraryId: string } | { file: File }
export type InterchangeSource = "m3u" | "rekordbox"

export async function inspectInterchangeFile(file: File): Promise<{ source: InterchangeSource; data: InterchangeLibrary }> {
  if (file.size <= 0 || file.size > MAX_INTERCHANGE_BYTES) throw new Error("Choose a playlist or XML export up to 12 MiB.")
  const contents = await file.text()
  if (/\.xml$/i.test(file.name)) return { source: "rekordbox", data: decodeRekordboxXml(contents) }
  if (/\.m3u8?$/i.test(file.name)) return { source: "m3u", data: decodeM3u(contents, file.name.replace(/\.m3u8?$/i, "")) }
  throw new Error("Choose an M3U, M3U8, or rekordbox XML file.")
}

function hasPreparation(track: InterchangeTrack) {
  return Boolean(track.cuePoints?.length || track.tempo?.length || track.bpm || track.key)
}

function importedSidecar(track: InterchangeTrack, fileName: string, duration: number): Sidecar {
  const warnings: string[] = []
  const cues: Cue[] = []
  for (const mark of track.cuePoints ?? []) {
    if (mark.timeSeconds < 0 || mark.timeSeconds > duration || (mark.endSeconds !== undefined
      && (mark.endSeconds > duration || mark.endSeconds < mark.timeSeconds + .05))) {
      warnings.push(`Omitted a cue or loop outside the playable range in ${track.title}.`)
      continue
    }
    const metadata: Record<string, unknown> = { studio_rekordbox_cue: {
      type: mark.type, hotCueSlot: mark.hotCueSlot,
    } }
    if (mark.color) metadata.color = mark.color
    if (mark.endSeconds !== undefined) metadata.loop = { kind: "manual", active: false, end_seconds: mark.endSeconds }
    cues.push({ label: mark.name || (mark.endSeconds === undefined ? "Cue" : "Loop"), time_seconds: mark.timeSeconds,
      confidence: 1, reason: "Position saved in the imported rekordbox XML.", metadata })
  }
  return { schema_version: 1, source_file: fileName, cues, warnings, analysis: {
    duration_seconds: duration, estimated_bpm: track.bpm ?? track.tempo?.[0]?.bpm,
    estimated_bpm_source: "rekordbox_xml", estimated_key: track.key,
    studio_rekordbox_tempo: track.tempo?.filter(segment => segment.timeSeconds < duration) ?? [],
  } }
}

export async function importInterchangePlaylists(data: InterchangeLibrary, source: InterchangeSource,
  assignments: ReadonlyMap<string, MediaAssignment>, decode: DecodeForPreparation) {
  const importedIds = new Map<string, string>()
  const warnings: string[] = []
  let preparations = 0
  let kept = 0
  for (const track of data.tracks) {
    const assignment = assignments.get(track.id)
    if (!assignment) continue
    try {
      let libraryId: string
      let file: File
      let duration: number | undefined
      if ("file" in assignment) {
        file = assignment.file
        if (!isAudioFile(file)) throw new Error("Choose a supported audio file.")
      } else {
        const saved = await openLibraryFile(assignment.libraryId)
        if (!saved) throw new Error("The chosen library track needs its audio.")
        file = saved.file
        duration = saved.entry.duration
      }
      const importPrep = source === "rekordbox" && hasPreparation(track)
      if (importPrep || (track.durationSeconds && duration === undefined)) {
        duration = (await decode(file, new AbortController().signal)).duration
      }
      if (track.durationSeconds && duration !== undefined && Math.abs(duration - track.durationSeconds) > 2) {
        throw new Error("The audio duration differs from the source. Check the version of this track.")
      }
      if ("file" in assignment) libraryId = (await addLibraryFile(file)).entry.id
      else libraryId = assignment.libraryId
      importedIds.set(track.id, libraryId)
      if (importPrep && duration !== undefined) {
        const prepared = importedSidecar(track, file.name, duration)
        if (await importMissingTrackPrep(libraryId, prepared)) {
          preparations++
          warnings.push(...prepared.warnings)
        } else kept++
      }
    } catch (cause) {
      warnings.push(`${track.title} · ${cause instanceof Error ? cause.message : "Could not import this track."}`)
    }
  }
  let playlists = 0
  let unchangedPlaylists = 0
  const signatures = new Set((await readTrackPlaylists()).map(playlist => JSON.stringify([playlist.name, playlist.trackIds])))
  for (const playlist of data.playlists) {
    const ids = [...new Set(playlist.trackIds.flatMap(id => importedIds.get(id) ?? []))]
    if (!ids.length) continue
    const name = [...(playlist.folderPath ?? []), playlist.name].join(" / ")
    const signature = JSON.stringify([name, ids])
    if (signatures.has(signature)) { unchangedPlaylists++; continue }
    try {
      const created = await createTrackPlaylist(name, ids)
      if (created.trackIds.length) {
        playlists++
        signatures.add(JSON.stringify([created.name, created.trackIds]))
      }
    } catch (cause) {
      warnings.push(`${name} · ${cause instanceof Error ? cause.message : "Could not create this playlist."}`)
    }
  }
  return { tracks: importedIds.size, playlists, unchangedPlaylists, preparations, kept, warnings }
}

export function exportParentPath(value: string): string | null {
  const cleaned = value.trim().replace(/^"(.*)"$/, "$1").replaceAll("\\", "/")
  if (!/^(?:[a-z]:\/|\/(?!\/))/i.test(cleaned) || /[\u0000-\u001f\u007f]/.test(cleaned)
    || cleaned.split("/").some(part => part === "." || part === "..")) return null
  return cleaned.replace(/\/+$/, "") + "/"
}

function safeName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[ .]+$/, "").trim()
}

function portableAudioName(filename: string, index: number) {
  const leaf = safeName(filename)
  const extension = /\.[a-z0-9]{1,8}$/i.exec(leaf)?.[0] ?? ""
  const stem = leaf.slice(0, leaf.length - extension.length).slice(0, 96) || "track"
  return String(index + 1).padStart(4, "0") + "-" + stem + extension
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: string | Blob) {
  try {
    await directory.getFileHandle(name)
    throw new Error(`A file called ${name} already exists in the export folder.`)
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "NotFoundError")) throw cause
  }
  const handle = await directory.getFileHandle(name, { create: true })
  const stream = await handle.createWritable()
  try {
    await stream.write(data)
    await stream.close()
  } catch (cause) {
    await stream.abort().catch(() => {})
    throw cause
  }
}

function exportedCue(trackCue: Cue, duration: number, slot: number | undefined): NonNullable<InterchangeTrack["cuePoints"]>[number] {
  const remembered = trackCue.metadata?.studio_rekordbox_cue
  const imported = remembered && typeof remembered === "object" ? remembered as Record<string, unknown> : null
  const variant = imported?.type
  const loop = getLoop(trackCue, duration)
  const hotCueSlot = imported ? (typeof imported.hotCueSlot === "number" ? imported.hotCueSlot : undefined) : slot
  return { name: trackCue.label, timeSeconds: trackCue.time_seconds, endSeconds: loop?.end_seconds,
    type: loop ? "loop" : variant === "fade-in" || variant === "fade-out" || variant === "load" ? variant : "cue",
    hotCueSlot, armed: loop?.active, color: cueColor(trackCue) }
}

function exportedTempo(sidecar: Sidecar | null, duration: number): InterchangeTempo[] {
  const analysis = sidecar?.analysis
  const manual = readManualBeatGrid(analysis?.studio_manual_grid, duration)
  if (manual) return [{ timeSeconds: manual.anchor_seconds, bpm: manual.bpm, meter: "4/4", beat: 1 }]
  const stored = analysis?.studio_rekordbox_tempo
  return Array.isArray(stored) ? stored.filter(segment => segment && typeof segment === "object") : []
}

export async function stagePlaylistExport(directory: FileSystemDirectoryHandle, playlist: TrackPlaylist, xmlParent: string | null,
  onProgress: (copied: number, total: number) => void) {
  const name = `Cue Studio - ${safeName(playlist.name).slice(0, 52) || "Playlist"} - ${crypto.randomUUID()}`
  try {
    await directory.getDirectoryHandle(name)
    throw new Error("The new export folder already exists. Try exporting again.")
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "NotFoundError")) throw cause
  }
  const target = await directory.getDirectoryHandle(name, { create: true })
  const portable: InterchangeTrack[] = []
  const xmlTracks: InterchangeTrack[] = []
  const warnings: string[] = []
  try {
    const audio = await target.getDirectoryHandle("Audio", { create: true })
    for (const [index, id] of playlist.trackIds.entries()) {
      const saved = await openLibraryFile(id)
      if (!saved) { warnings.push(`Playlist item ${index + 1} needs audio.`); continue }
      const { entry, file } = saved
      const leaf = portableAudioName(file.name, index)
      const location = `Audio/${leaf}`
      await writeFile(audio, leaf, file)
      const track = { id, location, title: entry.title ?? entry.name, artist: entry.artist,
        genre: entry.genres?.join(" / "), bpm: entry.bpm, key: entry.key, durationSeconds: entry.duration }
      portable.push(track)
      if (xmlParent) {
        const sidecar = await readTrackPrep(id)
        const duration = typeof sidecar?.analysis.duration_seconds === "number" ? sidecar.analysis.duration_seconds : entry.duration ?? Infinity
        const tempo = exportedTempo(sidecar, duration)
        if (readManualBeatGrid(sidecar?.analysis.studio_manual_grid, duration)) {
          warnings.push(`${track.title} · The manual grid exports as constant tempo in 4/4.`)
        }
        if (!tempo.length && readBeatTimes(sidecar?.analysis.studio_beatgrid, duration).length) {
          warnings.push(`${track.title} · Set a manual downbeat to include a grid in XML.`)
        }
        const occupied = new Set(sidecar?.cues.flatMap(cue => {
          const savedCue = cue.metadata?.studio_rekordbox_cue as { hotCueSlot?: number } | undefined
          return savedCue?.hotCueSlot === undefined ? [] : [savedCue.hotCueSlot]
        }))
        const cuePoints = sidecar?.cues.map(cue => {
          const next = cue.time_seconds < 0 || cue.metadata?.studio_rekordbox_cue ? undefined
            : Array.from({ length: 8 }, (_, slot) => slot).find(slot => !occupied.has(slot))
          if (next !== undefined) occupied.add(next)
          else if (cue.time_seconds >= 0 && !cue.metadata?.studio_rekordbox_cue) {
            warnings.push(`${track.title} · ${cue.label} became a memory cue because the hot cue slots are full.`)
          }
          return exportedCue(cue, duration, next)
        })
        xmlTracks.push({ ...track, bpm: tempo[0]?.bpm ?? track.bpm, location: `${xmlParent}${name}/${location}`, cuePoints, tempo })
      }
      onProgress(portable.length, playlist.trackIds.length)
    }
    if (!portable.length) throw new Error("The playlist needs at least one locally available track.")
    if (xmlParent) {
      const result = encodeRekordboxXml({ tracks: xmlTracks,
        playlists: [{ name: playlist.name, trackIds: xmlTracks.map(track => track.id) }], warnings: [] })
      warnings.push(...result.warnings)
      await writeFile(target, "rekordbox.xml", result.xml)
    }
    await writeFile(target, "playlist.m3u8", encodeM3u(portable))
    await writeFile(target, "export-report.json", JSON.stringify({ playlist: playlist.name,
      media: portable.map(({ id, location }) => ({ fingerprint: id, file: location })), warnings }, null, 2) + "\n")
    return { name, tracks: portable.length, warnings }
  } catch (cause) {
    throw new Error(`${name} contains a partial export. ${cause instanceof Error ? cause.message : "The copy did not finish."}`, { cause })
  }
}
