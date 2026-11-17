import type { InterchangeCue, InterchangeLibrary, InterchangePlaylist, InterchangeTempo, InterchangeTrack } from './interchangeTypes'

const cueTypes = ['cue', 'fade-in', 'fade-out', 'load', 'loop'] as const
const MAX_HOT_SLOT = 7
const MAX_INT = 2_147_483_647
const MAX_PLAYLIST_DEPTH = 64

function numeric(value: string | null): number | undefined {
  if (value === null || !/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(value.trim())) return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function validBpm(bpm: number | undefined): bpm is number {
  return bpm !== undefined && Number.isFinite(bpm) && bpm > 0
}

function validTime(time: number | undefined, duration?: number): time is number {
  return time !== undefined && Number.isFinite(time) && time >= 0 && (duration === undefined || time <= duration)
}

function validHotSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot <= MAX_HOT_SLOT
}

function tempoProblem(time: number | undefined, bpm: number | undefined, meter: string, beat: number | undefined,
  duration?: number): string | undefined {
  if (!validTime(time, duration)) return 'invalid timestamp'
  if (!validBpm(bpm)) return 'invalid BPM'
  const match = /^([1-9]\d{0,2})\/([1-9]\d{0,2})$/.exec(meter)
  if (!match) return 'invalid meter'
  if (beat === undefined || !Number.isInteger(beat) || beat < 1 || beat > Number(match[1])) return 'invalid beat number'
  return undefined
}

function positionProblem(time: number | undefined, end: number | undefined, type: InterchangeCue['type'],
  duration?: number): string | undefined {
  if (!validTime(time, duration)) return 'invalid timestamp outside the audio timeline'
  if (type === 'loop' && (!validTime(end, duration) || end <= time)) return 'invalid loop end'
  return undefined
}

/** Export uses the selected source path. File names embedded in uploaded audio are insufficient. */
function localFileUri(location: string): string | undefined {
  try {
    let input = location
    const windows = /^[a-z]:[\\/]/i.test(input)
    if (windows || input.startsWith('/') || input.startsWith('\\\\')) {
      const path = windows || input.startsWith('\\\\') ? input.replace(/\\/g, '/') : input
      const encoded = path.split('/').map((part, index) => windows && index === 0 ? part : encodeURIComponent(part)).join('/')
      input = encoded.startsWith('//') ? `file:${encoded}` : `file://localhost${windows ? '/' : ''}${encoded}`
    }
    if (!/^file:\/\//i.test(input)) return undefined
    const uri = new URL(input)
    if (uri.protocol !== 'file:' || uri.pathname.endsWith('/') || uri.search || uri.hash) return undefined
    // Reject malformed escapes and encoded separators that cannot identify a unique file path.
    if (/%(?:2f|5c|00)/i.test(uri.pathname)) return undefined
    const path = uri.pathname.split('/').map((segment, index) => {
      const decoded = decodeURIComponent(segment)
      return index === 1 && !uri.hostname && /^[a-z]:$/i.test(decoded) ? decoded : encodeURIComponent(decoded)
    }).join('/')
    return `file://${uri.hostname || 'localhost'}${path}`
  } catch {
    return undefined
  }
}

function children(element: Element | undefined, name: string): Element[] {
  return element ? Array.from(element.children).filter(child => child.tagName === name && !child.namespaceURI) : []
}

function attribute(element: Element, name: string): string {
  return element.getAttribute(name) ?? ''
}

function xmlTrackId(value: string): string | undefined {
  if (!/^-?\d+$/.test(value)) return undefined
  const id = Number(value)
  return id >= -MAX_INT - 1 && id <= MAX_INT ? String(id) : undefined
}

function readTempo(element: Element, duration: number | undefined, warn: (message: string) => void): InterchangeTempo[] {
  const rows: InterchangeTempo[] = []
  const anchorTimes = new Set<number>()
  for (const [index, row] of children(element, 'TEMPO').entries()) {
    const time = numeric(row.getAttribute('Inizio'))
    const bpm = numeric(row.getAttribute('Bpm'))
    const meter = attribute(row, 'Metro')
    const beat = numeric(row.getAttribute('Battito'))
    const problem = tempoProblem(time, bpm, meter, beat, duration)
    if (problem || time === undefined || bpm === undefined || beat === undefined) {
      warn(`Tempo row ${index + 1} skipped (${problem ?? 'invalid values'}).`)
    } else if (anchorTimes.has(time)) warn(`Tempo row ${index + 1} skipped (duplicate anchor at ${time}s).`)
    else {
      anchorTimes.add(time)
      rows.push({ timeSeconds: time, bpm, meter, beat })
    }
  }
  return rows.sort((a, b) => a.timeSeconds - b.timeSeconds)
}

function readMarks(element: Element, duration: number | undefined, warn: (message: string) => void): InterchangeCue[] {
  const cues: InterchangeCue[] = []
  const slots = new Set<number>()
  for (const [index, row] of children(element, 'POSITION_MARK').entries()) {
    const code = numeric(row.getAttribute('Type'))
    const type = code === undefined ? undefined : cueTypes[code]
    const time = numeric(row.getAttribute('Start'))
    const end = numeric(row.getAttribute('End'))
    const name = attribute(row, 'Name')
    const label = name || `Position mark ${index + 1}`
    const problem = type ? positionProblem(time, end, type, duration) : 'unsupported mark type'
    if (problem || type === undefined || time === undefined) {
      warn(`${label} skipped (${problem ?? 'invalid timestamp'}).`)
      continue
    }
    const cue: InterchangeCue = { name, timeSeconds: time, type }
    if (type === 'loop') cue.endSeconds = end
    else if (end !== undefined && end > 0 && end !== time) warn(`${label} has an end time on a non-loop marker. Its end was ignored.`)
    const rawSlot = row.getAttribute('Num')
    const slot = numeric(rawSlot)
    if (slot !== -1) {
      if (slot === undefined || !validHotSlot(slot)) warn(`${label} kept as a memory cue (slot outside A–H).`)
      else if (slots.has(slot)) warn(`${label} kept as a memory cue (duplicate hot cue slot).`)
      else {
        cue.hotCueSlot = slot
        slots.add(slot)
      }
    }
    const colorStrings = ['Red', 'Green', 'Blue'].map(key => row.getAttribute(key))
    if (colorStrings.some(value => value !== null)) {
      const rgb = colorStrings.map(numeric)
      if (rgb.every((value): value is number => value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255)) {
        cue.color = `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`
      } else warn(`${label} has invalid RGB color components.`)
    }
    cues.push(cue)
  }
  return cues
}

function readPlaylists(root: Element, tracks: Map<string, string | null>, locations: Map<string, string | null>,
  warnings: string[]): InterchangePlaylist[] {
  const playlists: InterchangePlaylist[] = []
  function visit(node: Element, folderPath: string[], depth: number): void {
    const kind = attribute(node, 'Type')
    const name = attribute(node, 'Name') || 'Untitled'
    if (depth > MAX_PLAYLIST_DEPTH) {
      warnings.push(`${name} skipped (playlist folder nesting is too deep).`)
    } else if (kind === '0') {
      const path = depth === 0 && name === 'ROOT' ? folderPath : [...folderPath, name]
      for (const child of children(node, 'NODE')) visit(child, path, depth + 1)
    } else if (kind === '1') {
      const keys = attribute(node, 'KeyType')
      if (keys !== '0' && keys !== '1') {
        warnings.push(`${name} skipped (unknown playlist key type).`)
        return
      }
      const trackIds: string[] = []
      for (const [index, entry] of children(node, 'TRACK').entries()) {
        const key = attribute(entry, 'Key')
        const id = keys === '0' ? tracks.get(xmlTrackId(key) ?? '') : locations.get(localFileUri(key) ?? key)
        if (id) trackIds.push(id)
        else warnings.push(`${name}: entry ${index + 1} has a missing or ambiguous track reference.`)
      }
      playlists.push({ name, trackIds, ...(folderPath.length ? { folderPath } : {}) })
    } else warnings.push(`${name} skipped (unknown playlist node type).`)
  }
  for (const node of children(children(root, 'PLAYLISTS')[0], 'NODE')) visit(node, [], 0)
  return playlists
}

export function decodeRekordboxXml(xml: string): InterchangeLibrary {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('rekordbox XML with a document type declaration is unsupported.')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This file is not well-formed XML.')
  const root = doc.documentElement
  const collection = children(root, 'COLLECTION')[0]
  if (root.tagName !== 'DJ_PLAYLISTS' || root.namespaceURI || !collection) {
    throw new Error('Choose a rekordbox XML file with a DJ_PLAYLISTS collection.')
  }

  const warnings: string[] = []
  const version = attribute(root, 'Version')
  if (version !== '1.0.0') warnings.push('This XML does not declare version 1.0.0. Only supported rekordbox fields were read.')
  const tracks: InterchangeTrack[] = []
  const ids = new Map<string, string | null>()
  const locations = new Map<string, string | null>()
  for (const [index, row] of children(collection, 'TRACK').entries()) {
    const location = attribute(row, 'Location')
    const title = attribute(row, 'Name') || `Track ${index + 1}`
    const warn = (message: string) => warnings.push(`${title}: ${message}`)
    if (!location.trim()) {
      warn('Track skipped (missing location).')
      continue
    }
    const rawId = attribute(row, 'TrackID')
    const idKey = xmlTrackId(rawId)
    const id = idKey ?? `track-${index + 1}`
    if (idKey && ids.has(idKey)) {
      ids.set(idKey, null)
      warn(`Track skipped (duplicate TrackID ${idKey}).`)
      continue
    }
    if (idKey) ids.set(idKey, id)
    else if (rawId) warn('Invalid TrackID. Only location-keyed playlist entries can reference this track.')
    const normalizedLocation = localFileUri(location)
    if (!normalizedLocation) warn('The source is not an absolute local audio location. Choose its audio manually.')
    const locationKey = normalizedLocation ?? location
    locations.set(locationKey, locations.has(locationKey) ? null : id)
    const track: InterchangeTrack = { id, location, title }
    const fields = { artist: 'Artist', album: 'Album', genre: 'Genre', key: 'Tonality' } as const
    for (const [field, key] of Object.entries(fields) as [keyof typeof fields, string][]) {
      const value = attribute(row, key)
      if (value) track[field] = value
    }
    const bpm = numeric(row.getAttribute('AverageBpm'))
    if (validBpm(bpm)) track.bpm = bpm
    else if (attribute(row, 'AverageBpm')) warn('Invalid track BPM ignored.')
    const duration = numeric(row.getAttribute('TotalTime'))
    if (validTime(duration) && duration > 0) track.durationSeconds = duration
    // Some exporters truncate TotalTime to integer seconds. Preserve sub-second end marks.
    const timeLimit = track.durationSeconds === undefined ? undefined : track.durationSeconds + 1
    const cuePoints = readMarks(row, timeLimit, warn)
    const tempo = readTempo(row, timeLimit, warn)
    if (cuePoints.length) track.cuePoints = cuePoints
    if (tempo.length) track.tempo = tempo
    tracks.push(track)
  }
  return { tracks, playlists: readPlaylists(root, ids, locations, warnings), warnings }
}

function xmlValue(value: string | number): string {
  const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' }
  // Replace only characters prohibited by XML 1.0.
  return String(value).replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '\uFFFD')
    .replace(/[&<>"\t\n\r]/g, character => escapes[character])
}

function xmlAttributes(attributes: Record<string, string | number | undefined>): string {
  return Object.entries(attributes).flatMap(([key, value]) => value === undefined ? [] : [` ${key}="${xmlValue(value)}"`]).join('')
}

function writeTrack(track: InterchangeTrack, id: number, location: string, lines: string[], warnings: string[]): void {
  const warn = (message: string) => warnings.push(`${track.title}: ${message}`)
  const bpm = validBpm(track.bpm) ? track.bpm : undefined
  const duration = validTime(track.durationSeconds) && track.durationSeconds > 0 ? track.durationSeconds : undefined
  if (track.bpm !== undefined && bpm === undefined) warn('Invalid track BPM skipped.')
  if (track.durationSeconds !== undefined && duration === undefined) warn('Invalid duration skipped.')
  const metadata = xmlAttributes({ TrackID: id, Name: track.title, Artist: track.artist, Album: track.album, Genre: track.genre,
    AverageBpm: bpm, Tonality: track.key, TotalTime: duration === undefined ? undefined : Math.round(duration), Location: location })
  const rows: string[] = []
  const anchorTimes = new Set<number>()
  for (const [index, anchor] of Array.from(track.tempo ?? []).sort((a, b) => a.timeSeconds - b.timeSeconds).entries()) {
    const problem = tempoProblem(anchor.timeSeconds, anchor.bpm, anchor.meter, anchor.beat, duration)
    if (problem) warn(`Tempo row ${index + 1} skipped (${problem}).`)
    else if (anchorTimes.has(anchor.timeSeconds)) warn(`Tempo row ${index + 1} skipped (duplicate anchor at ${anchor.timeSeconds}s).`)
    else {
      anchorTimes.add(anchor.timeSeconds)
      const attributes = xmlAttributes({ Inizio: anchor.timeSeconds, Bpm: anchor.bpm, Metro: anchor.meter, Battito: anchor.beat })
      rows.push(`      <TEMPO${attributes}/>`)
    }
  }

  const slots = new Set<number>()
  for (const cue of track.cuePoints ?? []) {
    const type = cue.type ?? (cue.endSeconds === undefined ? 'cue' : 'loop')
    const code = cueTypes.indexOf(type)
    const problem = code < 0 ? 'unsupported mark type' : positionProblem(cue.timeSeconds, cue.endSeconds, type, duration)
    if (problem) {
      warn(`${cue.name} skipped (${problem}).`)
      continue
    }
    let slot = -1
    if (cue.hotCueSlot !== undefined) {
      if (!validHotSlot(cue.hotCueSlot)) warn(`${cue.name} kept as a memory cue (slot outside A–H).`)
      else if (slots.has(cue.hotCueSlot)) warn(`${cue.name} kept as a memory cue (duplicate hot cue slot).`)
      else {
        slot = cue.hotCueSlot
        slots.add(slot)
      }
    }
    if (cue.armed && type === 'loop') warn(`${cue.name} was armed in Studio. rekordbox XML only stores its loop bounds.`)
    if (cue.endSeconds !== undefined && type !== 'loop') warn(`${cue.name} has a loop end on a non-loop marker. Its end was omitted.`)
    const color = cue.color && /^#[a-f\d]{6}$/i.test(cue.color) ? cue.color : undefined
    if (cue.color && !color) warn(`${cue.name} has a color that could not be mapped.`)
    else if (color && slot === -1) warn(`${cue.name} has a memory cue color that could not be mapped.`)
    const rgb = color && slot !== -1 ? [...color.slice(1).matchAll(/../g)].map(match => parseInt(match[0], 16)) : []
    const attributes = xmlAttributes({ Name: cue.name, Type: code, Start: cue.timeSeconds,
      End: type === 'loop' ? cue.endSeconds : undefined, Num: slot, Red: rgb[0], Green: rgb[1], Blue: rgb[2] })
    rows.push(`      <POSITION_MARK${attributes}/>`)
  }
  if (rows.length) {
    lines.push(`    <TRACK${metadata}>`)
    for (const row of rows) lines.push(row)
    lines.push('    </TRACK>')
  } else lines.push(`    <TRACK${metadata}/>`)
}

type PlaylistFolder = { name: string; children: (PlaylistFolder | PlaylistEntries)[]; folders: Map<string, PlaylistFolder>; names: Set<string> }
type PlaylistEntries = { name: string; trackIds: number[] }

function createFolder(name: string): PlaylistFolder {
  return { name, children: [], folders: new Map(), names: new Set() }
}

function uniqueName(name: string, folder: PlaylistFolder, warnings: string[]): string {
  let resolved = name
  for (let suffix = 2; folder.names.has(resolved.toLowerCase()); suffix++) resolved = `${name} (${suffix})`
  folder.names.add(resolved.toLowerCase())
  if (resolved !== name) warnings.push(`${name} renamed to ${resolved} to avoid a duplicate playlist or folder name.`)
  return resolved
}

function writePlaylists(lists: InterchangePlaylist[], ids: Map<string, number>, lines: string[], warnings: string[]): void {
  const root = createFolder('ROOT')
  for (const list of lists) {
    if ((list.folderPath?.length ?? 0) > MAX_PLAYLIST_DEPTH - 1) {
      warnings.push(`${list.name} skipped (playlist folder nesting is too deep).`)
      continue
    }
    let parent = root
    for (const segment of list.folderPath ?? []) {
      const group = segment.trim() || 'Untitled folder'
      if (!parent.folders.has(group)) {
        const folder = createFolder(uniqueName(group, parent, warnings))
        parent.children.push(folder)
        parent.folders.set(group, folder)
      }
      parent = parent.folders.get(group)!
    }
    const name = uniqueName(list.name.trim() || 'Untitled playlist', parent, warnings)
    const trackIds: number[] = []
    for (const id of list.trackIds) {
      const xmlId = ids.get(id)
      if (xmlId !== undefined) trackIds.push(xmlId)
      else warnings.push(`${name}: track ${id} omitted because it has no exportable source location.`)
    }
    parent.children.push({ name, trackIds })
  }
  function write(node: PlaylistFolder | PlaylistEntries, indent: string): void {
    if ('children' in node) {
      lines.push(`${indent}<NODE${xmlAttributes({ Type: 0, Name: node.name, Count: node.children.length })}>`)
      for (const child of node.children) write(child, `${indent}  `)
    } else {
      lines.push(`${indent}<NODE${xmlAttributes({ Type: 1, Name: node.name, KeyType: 0, Entries: node.trackIds.length })}>`)
      for (const id of node.trackIds) lines.push(`${indent}  <TRACK Key="${id}"/>`)
    }
    lines.push(`${indent}</NODE>`)
  }
  lines.push('  <PLAYLISTS>')
  write(root, '    ')
  lines.push('  </PLAYLISTS>')
}

export function encodeRekordboxXml(library: InterchangeLibrary): { xml: string; warnings: string[] } {
  const warnings = [...library.warnings]
  const ids = new Map<string, number>()
  const collection: string[] = []
  for (const track of library.tracks) {
    const location = localFileUri(track.location)
    if (!location) warnings.push(`${track.title}: track skipped (an absolute local audio path or file URI is required).`)
    else if (ids.has(track.id)) warnings.push(`${track.title}: track skipped (duplicate track identifier).`)
    else {
      const id = ids.size + 1
      ids.set(track.id, id)
      writeTrack(track, id, location, collection, warnings)
    }
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="Magik Cue Studio" Version="0.1.0" Company="Magik Cue Genie"/>',
    `  <COLLECTION Entries="${ids.size}">`, ...collection, '  </COLLECTION>',
  ]
  writePlaylists(library.playlists, ids, lines, warnings)
  lines.push('</DJ_PLAYLISTS>', '')
  return { xml: lines.join('\n'), warnings }
}
