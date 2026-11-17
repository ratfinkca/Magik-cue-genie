export interface InterchangeCue {
  name: string
  timeSeconds: number
  endSeconds?: number
  type?: 'cue' | 'fade-in' | 'fade-out' | 'load' | 'loop'
  /** Zero-based performance pad index. An omitted slot denotes a memory cue. */
  hotCueSlot?: number
  armed?: boolean
  color?: string
}

export interface InterchangeTempo {
  timeSeconds: number
  bpm: number
  meter: string
  /** One-based beat number within the meter. */
  beat: number
}

export interface InterchangeTrack {
  id: string
  location: string
  title: string
  artist?: string
  album?: string
  genre?: string
  bpm?: number
  key?: string
  durationSeconds?: number
  cuePoints?: InterchangeCue[]
  tempo?: InterchangeTempo[]
}

export interface InterchangePlaylist {
  name: string
  trackIds: string[]
  folderPath?: string[]
}

export interface InterchangeLibrary {
  tracks: InterchangeTrack[]
  playlists: InterchangePlaylist[]
  warnings: string[]
}
