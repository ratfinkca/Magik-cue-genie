import { useCallback, useEffect, useRef, useState } from "react"
import type { AuditionBehavior } from "./audio"
import type { HotCueGestureEnd, HotCueMode } from "./hotCueGesture"
import { readSidecar } from "./cues"
import type { Sidecar } from "./cues"
import {
  asSavedDeck, clearSavedDecks, makeSavedRecordKey, readSavedDeckHead, readSavedDecks, readSavedDeckSidecar,
  removeSavedDeck, removeSavedDeckHead, writeSavedDeck, writeSavedDeckHead, writeSavedDeckSidecar,
} from "./deckSession"
import type { SavedDeck } from "./deckSession"
import { createDemoBuffer } from "./demo"
import { prepareKeyLockSource } from "./keyLock"
import type { KeyLockSource } from "./keyLock"
import { createStemCacheReader, fetchDeckStems, withinStemMemoryLimit } from "./localStems"
import { queueLocalPreparation } from "./localPreparationQueue"
import { createNativeStemSource, FULL_STEM_LEVELS } from "./stemPlayback"
import type { DeckStem, DeckStemBank, DeckStemLevels, DeckStemStatus } from "./stemPlayback"
import { createStereoLevelMeter, SILENT_MIXER_LEVELS } from "./levelMeter"
import type { MixerLevels } from "./levelMeter"
import { diagnosticError, recordDiagnostic } from "./studioDiagnostics"
import {
  addLibraryFile, addLibraryFiles, deleteLibraryTrack, identifyLibraryTrack, LIBRARY_FILE_SIZE_MESSAGE, MAX_LIBRARY_FILE_BYTES, openLibraryFile,
  readLibraryTracks, readTrackPrep, subscribeLibrary, writeTrackPrep,
} from "./trackLibrary"
import type { LibraryTrack } from "./trackLibrary"
import { clampTrackTime, MIN_TRACK_SECONDS } from "./trackTime"
import { createTransitionEq, EQ_BANDS, flatEq, normalizeEqDb, normalizeFilter, normalizePan } from "./transitionEq"
import type { EqBand, EqSettings } from "./transitionEq"
import { createDeckEffects, DEFAULT_DECK_FX, normalizeDeckFx } from "./transitionFx"
import type { DeckFxSettings } from "./transitionFx"
import {
  DEFAULT_CROSSFADER_CURVE,
  getCrossfaderGain,
  isCrossfaderCurve,
  normalizeCrossfaderCustom,
  normalizeFaderPosition,
  normalizeGainDb,
  PITCH_MAX_PERCENT,
  PITCH_MIN_PERCENT,
} from "./transitionMixer"
import type { CrossfaderCurve, CrossfaderCustom } from "./transitionMixer"

export { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB } from "./transitionEq"
export type { EqBand } from "./transitionEq"
export type { AuditionBehavior } from "./audio"

export const deckIds = ["A", "B"] as const
export const MASTER_MIN_DB = -60
export const MASTER_MAX_DB = 6
export type DeckId = typeof deckIds[number]
export type DeckLoop = { start: number; end: number }
type PlayMode = DeckId | "both"
type Positions = Record<DeckId, number>
type DeckFlags = Record<DeckId, boolean>
type RememberedTrack = { key: string; track: TransitionTrack; sidecar?: Sidecar }
type RestoreStatus = "restoring" | "ready" | "unavailable"

export interface TransitionTrack {
  name: string
  buffer: AudioBuffer
  file?: File
  fingerprint?: string
  libraryId?: string
  demo?: boolean
  sidecar?: Sidecar
}

interface Deck {
  track: TransitionTrack | null
  start: string
  speed: string
  gainDb: number
  pan: number
  filter: number
  fx: DeckFxSettings
  keyLock: boolean
  keyLockPending: boolean
  keyLockError: string | null
  stemsStatus: DeckStemStatus
  stemLevels: DeckStemLevels
  stemsError: string | null
  eq: EqSettings
  loop: DeckLoop | null
  loopArmed: boolean
  loading: boolean
  error: string | null
}

type WaveScrub = {
  track: TransitionTrack
  origin: number
  position: number
  running: boolean
  excerptEnd?: number
  resumePending?: boolean
  previewFailed?: boolean
}

interface SourceOptions {
  context: AudioContext
  destination: AudioNode
  buffer: AudioBuffer
  startAt: number
  offset: number
  speed: number
  excerptEnd?: number
  loop: DeckLoop | null
  eq: EqSettings
  pan: number
  filter: number
  level: number
  keyLock?: KeyLockSource
  stems?: DeckStemBank
  stemLevels?: DeckStemLevels
  carryPosition?: boolean
  onEnd: () => void
  onError?: (error: Error) => void
}

interface DeckSource {
  node: AudioNode
  keyLock?: KeyLockSource
  speed: number
  eq: ReturnType<typeof createTransitionEq>
  position: () => number
  positionAt: (time: number) => number
  start: (options: SourceOptions) => void
  setSpeed: (rate: number) => void
  armLoop: (range: DeckLoop) => boolean
  setLevel: (level: number) => void
  setStemLevels: (levels: DeckStemLevels) => void
  stop: (immediate: boolean, handoffAt?: number, nextLock?: KeyLockSource) => void
}

/** One source chain and clock offset per deck, even during a synchronized start. */
export function createDeckSources() {
  const live: Partial<Record<DeckId, DeckSource>> = {}

  const pause = (id: DeckId, immediate = false) => {
    const source = live[id]
    if (!source) return undefined
    const position = source.position()
    delete live[id]
    source.stop(immediate)
    return position
  }

  function start(id: DeckId, options: SourceOptions) {
    const { context, buffer, keyLock } = options
    const previous = live[id]
    if (keyLock && previous?.keyLock === keyLock) {
      previous.start(options)
      return previous.node
    }
    let stemLevels = options.stemLevels ?? FULL_STEM_LEVELS
    let native = keyLock ? undefined : createNativeStemSource(context, buffer, options.stems, stemLevels)
    const node = keyLock?.node ?? native!.node
    const gain = context.createGain()
    const eq = createTransitionEq(context, options.eq, { pan: options.pan, filter: options.filter })
    let startAt = options.startAt
    let excerptEnd = options.excerptEnd
    let activeLoop: DeckLoop | null = null
    let anchorTime = startAt
    let anchorPosition = options.offset
    let rate = options.speed
    let run = 0
    let outgoing = options.carryPosition ? previous : undefined
    let nativeLaunch = options.startAt
    let endNative: (() => void) | undefined
    function sampleZeroTime() {
      return anchorTime + Math.max(0, -anchorPosition) / rate
    }
    function launchNative(voice: NonNullable<typeof native>) {
      const offset = Math.max(0, anchorPosition)
      // An excerpt ending before zero schedules a zero-length node on the same clock.
      const end = Math.min(0, excerptEnd ?? 0)
      nativeLaunch = anchorTime + Math.max(0, end - anchorPosition) / rate
      voice.onEnded(() => { if (native === voice) endNative?.() })
      // The native duration is measured in decoded track seconds at any playback rate.
      voice.start(nativeLaunch, offset, excerptEnd === undefined ? undefined : Math.max(0, excerptEnd - offset), rate, activeLoop)
    }
    function positionAt(now: number) {
      if (now < startAt && outgoing) return outgoing.positionAt(now)
      const time = anchorPosition + Math.max(0, now - anchorTime) * rate
      return activeLoop && time >= activeLoop.end
        ? activeLoop.start + (time - activeLoop.end) % (activeLoop.end - activeLoop.start)
        : Math.min(excerptEnd ?? buffer.duration, time)
    }
    node.connect(eq.input)
    eq.output.connect(gain)
    gain.connect(options.destination)

    let disconnected = false
    const disconnect = () => {
      if (disconnected) return
      disconnected = true
      try { source.node.disconnect(eq.input) } catch { /* A released worklet may already be disconnected. */ }
      native?.disconnect()
      eq.disconnect()
      gain.disconnect()
    }
    const source: DeckSource = {
      eq, keyLock, positionAt,
      get node() { return keyLock?.node ?? native!.node },
      get speed() { return rate },
      position() {
        const now = context.currentTime
        if (now >= startAt) outgoing = undefined
        return positionAt(now)
      },
      setSpeed(nextRate) {
        if (nextRate === rate) return
        const now = context.currentTime
        const at = Math.max(startAt, now)
        const position = positionAt(at)
        if (keyLock) keyLock.setRate(nextRate, at)
        // Keep the original start time while the shared-clock launch is pending.
        anchorPosition = position
        anchorTime = at
        rate = nextRate
        if (native) {
          if (position < 0 && now < nativeLaunch) {
            // A buffer source is single-use, so requeue the source while it is still silent.
            const previous = native
            native = createNativeStemSource(context, buffer, options.stems, stemLevels)
            native.node.connect(eq.input)
            launchNative(native)
            previous.stop(now)
            previous.node.disconnect(eq.input)
            previous.disconnect()
          } else native.setRate(nextRate, now)
        }
      },
      armLoop(range) {
        const at = Math.max(startAt, context.currentTime)
        if (activeLoop || excerptEnd !== undefined || !validLoop(range, buffer.duration)
          || positionAt(at) >= range.end) return false
        if (keyLock) keyLock.setLoop(range, at)
        else native!.setLoop(range)
        activeLoop = range
        return true
      },
      start(next) {
        const ticket = ++run
        const offset = next.offset
        startAt = anchorTime = next.startAt
        excerptEnd = next.excerptEnd
        anchorPosition = offset
        rate = next.speed
        if (!next.carryPosition && outgoing) {
          outgoing.stop(false, startAt, keyLock)
          outgoing = undefined
        }
        activeLoop = next.loop && excerptEnd === undefined && offset < next.loop.end ? next.loop : null
        const ended = () => {
          if (run !== ticket) return
          disconnect()
          if (live[id] !== source) return
          delete live[id]
          next.onEnd()
        }
        source.setLevel(next.level)
        source.setStemLevels(next.stemLevels ?? FULL_STEM_LEVELS)
        if (keyLock) {
          keyLock.start({
            at: startAt, offset, speed: rate, loop: activeLoop, excerptEnd,
            onEnd: ended,
            onError(cause) {
              queueMicrotask(() => {
                if (run === ticket && live[id] === source) next.onError?.(cause)
              })
            },
          })
        } else {
          endNative = ended
          launchNative(native!)
        }
      },
      setLevel(level) {
        const now = context.currentTime
        if (now < startAt) {
          gain.gain.cancelScheduledValues(startAt)
          gain.gain.setValueAtTime(0, startAt)
          gain.gain.linearRampToValueAtTime(level, startAt + .008)
        } else {
          gain.gain.cancelScheduledValues(now)
          gain.gain.setTargetAtTime(level, now, .008)
        }
      },
      setStemLevels(next) {
        stemLevels = next
        keyLock?.setStemLevels?.(next)
        native?.setLevels?.(next)
      },
      stop(immediate, handoffAt, nextLock) {
        const now = context.currentTime
        outgoing?.stop(immediate, handoffAt, nextLock)
        const fadeAt = immediate ? now : Math.max(now, (handoffAt ?? now) - .004)
        let stopAt = immediate ? now : fadeAt + .012
        if (handoffAt === undefined && now < sampleZeroTime()) stopAt = Math.min(stopAt, sampleZeroTime())
        ++run
        native?.onEnded(disconnect)
        try {
          gain.gain.cancelScheduledValues(fadeAt)
          gain.gain.setTargetAtTime(0, fadeAt, .003)
          if (keyLock) {
            // The same prepared node may already be scheduled on another graph after a rapid toggle.
            if (keyLock !== nextLock) keyLock.stop(stopAt)
            if (!immediate) setTimeout(disconnect, (stopAt - now) * 1000 + 20)
          } else native!.stop(stopAt)
        } catch {
          disconnect()
        }
        if (immediate) disconnect()
      },
    }
    try {
      source.start(options)
    } catch (cause) {
      disconnect()
      throw cause
    }
    previous?.stop(false, options.carryPosition ? options.startAt : undefined, keyLock)
    live[id] = source
    return node
  }

  return {
    start, pause,
    position: (id: DeckId) => live[id]?.position(),
    positionAt: (id: DeckId, time: number) => live[id]?.positionAt(time),
    armLoop: (id: DeckId, range: DeckLoop) => live[id]?.armLoop(range) ?? false,
    speed: (id: DeckId) => live[id]?.speed,
    setSpeed: (id: DeckId, rate: number) => live[id]?.setSpeed(rate),
    has: (id: DeckId) => Boolean(live[id]),
    setLevel: (id: DeckId, level: number) => live[id]?.setLevel(level),
    setStemLevels: (id: DeckId, levels: DeckStemLevels) => live[id]?.setStemLevels(levels),
    setBand: (id: DeckId, band: EqBand, db: number) => live[id]?.eq.setBand(band, db),
    setPan: (id: DeckId, value: number) => live[id]?.eq.setPan(value),
    setFilter: (id: DeckId, value: number) => live[id]?.eq.setFilter(value),
  }
}

const flagsOff = (): DeckFlags => ({ A: false, B: false })
const emptyPositions = (): Positions => ({ A: 0, B: 0 })
const emptyDeck = (eq: EqSettings, mixer: Pick<Deck, "gainDb" | "pan" | "filter" | "fx">): Deck => ({
  track: null, start: "0", speed: "100", eq, ...mixer, keyLock: false, keyLockPending: false, keyLockError: null,
  stemsStatus: "idle", stemLevels: FULL_STEM_LEVELS, stemsError: null,
  loop: null, loopArmed: false, loading: false, error: null,
})
const eqStorageKey = "magik.twoDeckEq"
const mixerStorageKey = "magik.transitionMixer"

function readMixerPreferences() {
  let saved: {
    gains?: Partial<Record<DeckId, unknown>>
    pan?: Partial<Record<DeckId, unknown>>
    filter?: Partial<Record<DeckId, unknown>>
    fx?: Partial<Record<DeckId, unknown>>
    masterDb?: unknown
    curve?: unknown
    customCurve?: unknown
    keyLock?: Partial<DeckFlags>
  } = {}
  try { saved = JSON.parse(localStorage.getItem(mixerStorageKey) || "{}") ?? {} } catch { /* Storage is optional. */ }
  return {
    gains: { A: normalizeGainDb(saved.gains?.A), B: normalizeGainDb(saved.gains?.B) },
    pan: { A: normalizePan(saved.pan?.A), B: normalizePan(saved.pan?.B) },
    filter: { A: normalizeFilter(saved.filter?.A), B: normalizeFilter(saved.filter?.B) },
    fx: { A: normalizeDeckFx(saved.fx?.A), B: normalizeDeckFx(saved.fx?.B) },
    masterDb: normalizeMasterDb(saved.masterDb),
    curve: isCrossfaderCurve(saved.curve) ? saved.curve : DEFAULT_CROSSFADER_CURVE,
    customCurve: normalizeCrossfaderCustom(saved.customCurve),
    keyLock: { A: saved.keyLock?.A === true, B: saved.keyLock?.B === true },
  }
}

function readDecks({ gains, pan, filter, fx }: ReturnType<typeof readMixerPreferences>): Record<DeckId, Deck> {
  let stored: Partial<Record<DeckId, Partial<EqSettings>>> = {}
  try { stored = JSON.parse(localStorage.getItem(eqStorageKey) || "{}") ?? {} } catch { /* Storage is optional. */ }
  function settings(id: DeckId): Deck {
    const eq = flatEq()
    for (const band of EQ_BANDS) eq[band] = normalizeEqDb(stored[id]?.[band] ?? 0)
    return emptyDeck(eq, { gainDb: gains[id], pan: pan[id], filter: filter[id], fx: fx[id] })
  }
  return { A: settings("A"), B: settings("B") }
}

function boundedPosition(track: TransitionTrack, seconds: number) {
  const max = Math.max(0, track.buffer.duration - 1 / track.buffer.sampleRate)
  return clampTrackTime(Number.isFinite(seconds) ? seconds : 0, max)
}

function startPosition(deck: Deck): number {
  return deck.track ? boundedPosition(deck.track, Number(deck.start) || 0) : 0
}

function validSettings(deck: Deck): boolean {
  if (!deck.track || deck.loading || !deck.start.trim() || !deck.speed.trim()) return false
  const start = Number(deck.start)
  const speed = Number(deck.speed)
  return start >= MIN_TRACK_SECONDS && start < deck.track.buffer.duration && validSpeed(speed)
}

function validSpeed(percent: number) {
  return percent >= PITCH_MIN_PERCENT && percent <= PITCH_MAX_PERCENT
}

function validLoop(range: DeckLoop, duration: number) {
  return Number.isFinite(range.start) && Number.isFinite(range.end)
    && range.start >= 0 && range.end <= duration && range.end >= range.start + .05
}

function checkBuffer(buffer: AudioBuffer) {
  if (!(buffer.duration > 0) || buffer.duration > 30 * 60) {
    throw new Error("Choose a track with audio under 30 minutes.")
  }
}

function stemFingerprint(track: TransitionTrack | null) {
  return track?.fingerprint ?? track?.libraryId
}

function sameStemSource(track: TransitionTrack, other: TransitionTrack | null) {
  const fingerprint = stemFingerprint(track)
  return other && fingerprint && fingerprint === stemFingerprint(other)
    && track.buffer.sampleRate === other.buffer.sampleRate && track.buffer.length === other.buffer.length
}

function playMode(flags: DeckFlags): PlayMode | null {
  return flags.A ? flags.B ? "both" : "A" : flags.B ? "B" : null
}

function trimGain(gainDb: number) {
  return 10 ** (gainDb / 20)
}

function normalizeMasterDb(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MASTER_MIN_DB, Math.min(MASTER_MAX_DB, value)) : 0
}

function masterGain(db: number) {
  const level = normalizeMasterDb(db)
  // At unity leave room for correlated decks. The bottom position is a mute.
  return level === MASTER_MIN_DB ? 0 : .7 * trimGain(level)
}

type OutputSettings = { masterDb?: number; fx?: Record<DeckId, DeckFxSettings> }

/** Deck meters follow trim and effects, and the master meter follows output protection. */
export function createTransitionOutput(context: AudioContext, initialFader: Record<DeckId, number>, settings: OutputSettings = {}) {
  const master = context.createGain()
  master.gain.value = masterGain(settings.masterDb ?? 0)
  const protection = context.createDynamicsCompressor()
  protection.threshold.value = -3
  protection.knee.value = 2
  protection.ratio.value = 12
  protection.attack.value = .003
  protection.release.value = .12
  master.connect(protection)
  protection.connect(context.destination)

  function deckOutput(id: DeckId) {
    const input = context.createGain()
    input.channelCount = 2
    input.channelCountMode = "explicit"
    const effects = createDeckEffects(context, settings.fx?.[id] ?? DEFAULT_DECK_FX)
    const fader = context.createGain()
    fader.gain.value = initialFader[id]
    input.connect(effects.input)
    effects.output.connect(fader)
    fader.connect(master)
    return { input, fader, effects }
  }

  const decks = { A: deckOutput("A"), B: deckOutput("B") }
  let meters: Record<keyof MixerLevels, ReturnType<typeof createStereoLevelMeter>> | undefined
  return {
    context, decks, protection,
    setMasterDb(db: number) {
      const now = context.currentTime
      const gain = masterGain(db)
      master.gain.cancelScheduledValues(now)
      if (context.state === "running") master.gain.setTargetAtTime(gain, now, .008)
      else master.gain.setValueAtTime(gain, now)
    },
    getLevels(): MixerLevels {
      if (context.state !== "running") return SILENT_MIXER_LEVELS
      meters ??= {
        A: createStereoLevelMeter(context, decks.A.effects.output),
        B: createStereoLevelMeter(context, decks.B.effects.output),
        master: createStereoLevelMeter(context, protection),
      }
      return { A: meters.A.read(), B: meters.B.read(), master: meters.master.read() }
    },
    disconnect() {
      if (meters) for (const meter of Object.values(meters)) meter.disconnect()
      for (const deck of Object.values(decks)) {
        deck.input.disconnect()
        deck.effects.disconnect()
        deck.fader.disconnect()
      }
      master.disconnect()
      protection.disconnect()
    },
  }
}

/** Both decks share one AudioContext. Files only enter the browser's decoder. */
export function useTransitionAudio() {
  const [mixerPreferences] = useState(readMixerPreferences)
  const [decks, setDecks] = useState(() => readDecks(mixerPreferences))
  const decksRef = useRef(decks)
  const [positions, setPositions] = useState<Positions>(emptyPositions)
  const [fader, setFader] = useState(0)
  const [curve, setSelectedCurve] = useState(mixerPreferences.curve)
  const [customCurve, setSelectedCustomCurve] = useState(mixerPreferences.customCurve)
  const [masterDb, setMasterLevel] = useState(mixerPreferences.masterDb)
  const keyLockAvailable = typeof AudioWorkletNode !== "undefined"
  const [playing, setPlaying] = useState<DeckFlags>(flagsOff)
  const [starting, setStarting] = useState<DeckFlags>(flagsOff)
  const [paused, setPaused] = useState<DeckFlags>(flagsOff)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<DeckFlags>({ A: true, B: true })
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibraryTrack[]>([])
  const [libraryStatus, setLibraryStatus] = useState<"loading" | "ready" | "unavailable">("loading")
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null)
  const outputRef = useRef<ReturnType<typeof createTransitionOutput> | null>(null)
  const [sources] = useState(createDeckSources)
  const [scrubSources] = useState(createDeckSources)
  const faderRef = useRef(0)
  const curveRef = useRef(curve)
  const customCurveRef = useRef(customCurve)
  const masterDbRef = useRef(masterDb)
  const keyLockPreference = useRef(mixerPreferences.keyLock)
  const keyLockVersion = useRef({ A: 0, B: 0 })
  const lockSource = useRef<Partial<Record<DeckId, KeyLockSource>>>({})
  const lockPreparation = useRef<Partial<Record<DeckId, Promise<boolean>>>>({})
  const stemBanks = useRef<Partial<Record<DeckId, DeckStemBank>>>({})
  const [readStemCache] = useState(createStemCacheReader)
  const stemRequests = useRef<Partial<Record<DeckId, AbortController>>>({})
  const stemHandoffs = useRef<Partial<Record<DeckId, Promise<void>>>>({})
  const loadVersion = useRef({ A: 0, B: 0 })
  const restoreVersion = useRef(0)
  const cacheGeneration = useRef(0)
  const mounted = useRef(false)
  const remembered = useRef<Partial<Record<DeckId, RememberedTrack>>>({})
  const cacheQueue = useRef<Promise<unknown>>(Promise.resolve())
  const playVersion = useRef({ A: 0, B: 0 })
  const hotCuePresses = useRef<Partial<Record<DeckId, symbol>>>({})
  const excerptEnds = useRef<Partial<Positions>>({})
  const scrubs = useRef<Partial<Record<DeckId, WaveScrub>>>({})
  const startPending = useRef<DeckFlags>(flagsOff())
  const positionRef = useRef<Positions>(emptyPositions())

  const getPositions = useCallback((): Positions => ({
    A: sources.position("A") ?? positionRef.current.A,
    B: sources.position("B") ?? positionRef.current.B,
  }), [sources])

  const getLevels = useCallback((): MixerLevels => {
    const { A, B } = decksRef.current
    if (!A.fx.enabled && !B.fx.enabled && !deckIds.some(id => sources.has(id) || scrubSources.has(id))) return SILENT_MIXER_LEVELS
    return outputRef.current?.getLevels() ?? SILENT_MIXER_LEVELS
  }, [sources, scrubSources])

  useEffect(() => {
    mounted.current = true
    const version = ++restoreVersion.current
    void restoreSavedTracks(version, { ...loadVersion.current })
    const rememberHeads = () => {
      const heads = getPositions()
      for (const id of deckIds) checkpoint(id, heads[id])
    }
    window.addEventListener("pagehide", rememberHeads)
    return () => {
      mounted.current = false
      restoreVersion.current++
      window.removeEventListener("pagehide", rememberHeads)
    }
  }, [getPositions])

  useEffect(() => {
    let revision = 0
    let disposed = false
    async function refresh() {
      const version = ++revision
      try {
        const tracks = await readLibraryTracks()
        if (disposed || version !== revision) return
        setLibrary(tracks)
        setLibraryStatus("ready")
      } catch (cause) {
        if (disposed || version !== revision) return
        recordDiagnostic("warn", "storage.library.read_failed", diagnosticError(cause))
        setLibraryStatus("unavailable")
        setLibraryNotice("The local library is unavailable. You can still open files directly on a deck.")
      }
    }
    void refresh()
    const unsubscribe = subscribeLibrary(() => { void refresh() })
    return () => { disposed = true; unsubscribe() }
  }, [])

  useEffect(() => () => {
    for (const id of deckIds) {
      loadVersion.current[id]++
      playVersion.current[id]++
      delete hotCuePresses.current[id]
      startPending.current[id] = false
      delete excerptEnds.current[id]
      discardScrub(id, true)
      sources.pause(id, true)
      releaseKeyLock(id)
      releaseStems(id)
    }
    const output = outputRef.current
    outputRef.current = null
    if (output) {
      output.disconnect()
      if (output.context.state !== "closed") void output.context.close().catch(() => {})
    }
  }, [sources])

  const mode = playMode(playing)
  useEffect(() => {
    if (mode === null) return
    let nextCheckpoint = performance.now() + 3000
    const interval = window.setInterval(() => {
      const next = getPositions()
      positionRef.current = next
      setPositions(next)
      const now = performance.now()
      if (now >= nextCheckpoint) {
        for (const id of mode === "both" ? deckIds : [mode]) checkpoint(id, next[id])
        nextCheckpoint = now + 3000
      }
    }, 50)
    return () => window.clearInterval(interval)
  }, [mode, getPositions])

  function output() {
    if (!outputRef.current) {
      let context: AudioContext | undefined
      try {
        context = new AudioContext()
        const { A, B } = decksRef.current
        outputRef.current = createTransitionOutput(context, { A: faderGain("A"), B: faderGain("B") }, {
          masterDb: masterDbRef.current, fx: { A: A.fx, B: B.fx },
        })
        const opened = context
        recordDiagnostic("info", "audio.context.open", { sampleRate: opened.sampleRate, state: opened.state })
        opened.addEventListener("statechange", () => recordDiagnostic("info", "audio.context.state", { state: opened.state }))
      } catch (cause) {
        recordDiagnostic("error", "audio.context.failed", diagnosticError(cause))
        if (context && context.state !== "closed") void context.close().catch(() => {})
        throw cause
      }
    }
    return outputRef.current
  }

  function updateDeck(id: DeckId, patch: Partial<Deck>) {
    const next = { ...decksRef.current, [id]: { ...decksRef.current[id], ...patch } }
    decksRef.current = next
    setDecks(next)
  }

  function updatePosition(id: DeckId, position: number) {
    const next = { ...positionRef.current, [id]: position }
    positionRef.current = next
    setPositions(next)
  }

  function checkpoint(id: DeckId, position: number) {
    if (scrubs.current[id]) return
    const saved = remembered.current[id]
    const deck = decksRef.current[id]
    const start = Number(deck.start)
    if (!saved || saved.track !== deck.track || !deck.start.trim() || !Number.isFinite(start) || !Number.isFinite(position)) return
    writeSavedDeckHead(id, { key: saved.key, start, position })
  }

  const cachedStorageFailure = useCallback((event: string, cause: unknown, deck?: DeckId) => {
    recordDiagnostic("warn", event, { deck: deck ?? null, ...diagnosticError(cause) })
    if (!mounted.current) return
    setStorageUnavailable(true)
    const quota = cause instanceof DOMException && cause.name === "QuotaExceededError"
    setRestoreNotice(quota ? "Browser storage is full. Studio may ask you to reopen tracks next time."
      : "Saved tracks are currently unavailable. You can still open and play local files.")
  }, [])

  const queueCacheWrite = useCallback((event: string, write: () => Promise<void>, deck?: DeckId) => {
    const pending = cacheQueue.current.then(write).then(() => true, cause => {
      cachedStorageFailure(event, cause, deck)
      return false
    })
    cacheQueue.current = pending
    return pending
  }, [cachedStorageFailure])

  function saveTrack(id: DeckId, track: TransitionTrack, generation: number) {
    if (cacheGeneration.current !== generation) return
    const start = Number(decksRef.current[id].start)
    const key = makeSavedRecordKey()
    const fields = { deck: id, key, name: track.name, start }
    let record: SavedDeck | null = null
    if (track.demo) record = { ...fields, kind: "demo", sidecar: track.sidecar }
    else if (track.libraryId) record = { ...fields, kind: "library", libraryId: track.libraryId }
    else if (track.file) record = {
      ...fields, kind: "file", audio: track.file, fileName: track.file.name, lastModified: track.file.lastModified, sidecar: track.sidecar,
    }
    if (!record) {
      if (remembered.current[id]) {
        delete remembered.current[id]
        removeSavedDeckHead(id)
        void queueCacheWrite("storage.deck.remove_failed", () => removeSavedDeck(id), id)
      }
      return
    }
    remembered.current[id] = { key, track, sidecar: track.sidecar }
    checkpoint(id, positionRef.current[id])
    return queueCacheWrite("storage.deck.save_failed", async () => {
      await writeSavedDeck(record)
      recordDiagnostic("info", "storage.deck.saved", { deck: id, kind: record.kind })
    }, id)
  }

  const saveTrackSidecar = useCallback((id: DeckId, track: TransitionTrack, sidecar: Sidecar) => {
    const saved = remembered.current[id]
    if (!saved || track.demo || track.libraryId || saved.track !== track || saved.sidecar === sidecar || decksRef.current[id].track !== track) return
    saved.sidecar = sidecar
    void queueCacheWrite("storage.sidecar.save_failed", async () => {
      if (remembered.current[id] === saved) await writeSavedDeckSidecar(id, saved.key, sidecar)
    }, id)
  }, [queueCacheWrite])

  function clearSavedTracks() {
    restoreVersion.current++
    cacheGeneration.current++
    remembered.current = {}
    setRestoring(flagsOff())
    for (const id of deckIds) removeSavedDeckHead(id)
    return queueCacheWrite("storage.deck.clear_failed", async () => {
      await clearSavedDecks()
      recordDiagnostic("info", "storage.deck.cleared")
      if (mounted.current) {
        setStorageUnavailable(false)
        setRestoreNotice(null)
      }
    })
  }

  function applyCachedSidecar(id: DeckId, track: TransitionTrack, sidecar?: Sidecar | null) {
    if (!sidecar) return
    try {
      const fileName = track.file?.name ?? sidecar.source_file
      const data = track.libraryId ? { ...sidecar, source_file: fileName } : sidecar
      track.sidecar = readSidecar(JSON.stringify(data), fileName, track.buffer.duration)
    } catch (cause) {
      recordDiagnostic("warn", "storage.sidecar.invalid", { deck: id, ...diagnosticError(cause) })
    }
  }

  function readLibraryPrep(id: DeckId, trackId: string) {
    return readTrackPrep(trackId).catch(cause => {
      recordDiagnostic("warn", "storage.library.prep_read_failed", { deck: id, ...diagnosticError(cause) })
      return null
    })
  }

  async function restoreSavedTracks(run: number, versions: Record<DeckId, number>) {
    const current = (id: DeckId) => restoreVersion.current === run && loadVersion.current[id] === versions[id]
    let records: (SavedDeck | null)[]
    try {
      records = (await readSavedDecks()).map(asSavedDeck)
    } catch (cause) {
      if (restoreVersion.current !== run) return
      cachedStorageFailure("storage.deck.restore_read_failed", cause)
      setRestoring(flagsOff())
      return
    }
    if (restoreVersion.current !== run) return
    recordDiagnostic("info", "storage.deck.restore_read", { count: records.filter(Boolean).length })
    let demo: AudioBuffer | undefined
    await Promise.all(deckIds.map(async id => {
      try {
        const record = records.find(item => item?.deck === id)
        if (!record || !current(id) || decksRef.current[id].track || decksRef.current[id].loading) return
        let track: TransitionTrack | null
        let sidecar = record.sidecar
        if (record.kind === "demo") {
          demo ??= createDemoBuffer(output().context)
          track = { name: record.name, buffer: demo, demo: true }
        } else if (record.kind === "library") {
          track = await decodeLibraryTrack(id, record.libraryId, () => current(id))
          if (!track || !current(id)) return
          track.name = record.name
        } else {
          const file = new File([record.audio], record.fileName, { type: record.audio.type, lastModified: record.lastModified })
          const [decoded, savedSidecar] = await Promise.all([
            decodeOpenedFile(id, file, () => current(id)),
            readSavedDeckSidecar(id, record.key).catch(cause => {
              recordDiagnostic("warn", "storage.sidecar.restore_failed", { deck: id, ...diagnosticError(cause) })
              return undefined
            }),
          ])
          track = decoded
          if (!track || !current(id)) return
          track.name = record.name
          sidecar = savedSidecar ?? sidecar
        }
        if (!current(id)) return
        const hadPrep = Boolean(track.sidecar)
        if (!hadPrep) applyCachedSidecar(id, track, sidecar)
        const head = readSavedDeckHead(id, record.key)
        commitTrack(id, track, head?.start ?? record.start, { pausedAt: head?.position ?? record.start })
        remembered.current[id] = { key: record.key, track, sidecar: track.sidecar }
        recordDiagnostic("info", "storage.deck.restored", { deck: id, kind: record.kind })
        if (record.kind === "file" && track.libraryId) {
          const libraryId = track.libraryId
          const prep = track.sidecar
          void queueCacheWrite("storage.deck.migrate_failed", async () => {
            if (!current(id)) return
            const { deck, key, name, start } = record
            if (!hadPrep && prep && !await readTrackPrep(libraryId)) await writeTrackPrep(libraryId, prep)
            if (current(id)) await writeSavedDeck({ deck, key, name, start, kind: "library", libraryId })
          }, id)
        }
      } catch (cause) {
        if (!current(id)) return
        recordDiagnostic("warn", "storage.deck.restore_decode_failed", { deck: id, ...diagnosticError(cause) })
        setRestoreNotice(previous => previous ? "Some saved tracks could not be reopened. You can load them again manually."
          : `Deck ${id}’s saved track could not be reopened. You can load it again manually.`)
      } finally {
        if (current(id)) setRestoring(previous => ({ ...previous, [id]: false }))
      }
    }))
  }

  function beginSource(id: DeckId, offset: number, startAt: number, keyLock?: KeyLockSource, carryPosition = false) {
    const deck = decksRef.current[id]
    if (!deck.track) return
    const { context, decks: outputDecks } = output()
    const { buffer } = deck.track
    const percent = Number(deck.speed)
    const speed = validSpeed(percent) ? percent / 100 : sources.speed(id) ?? 1
    const excerptEnd = excerptEnds.current[id]
    sources.start(id, {
      context, destination: outputDecks[id].input, buffer, startAt, offset,
      speed, loop: deck.loop, eq: deck.eq, pan: deck.pan, filter: deck.filter, excerptEnd, keyLock, carryPosition,
      stems: stemBanks.current[id], stemLevels: deck.stemLevels,
      level: trimGain(deck.gainDb),
      onEnd() {
        delete excerptEnds.current[id]
        updatePosition(id, excerptEnd ?? buffer.duration)
        checkpoint(id, excerptEnd ?? buffer.duration)
        setPlaying(previous => ({ ...previous, [id]: false }))
        if (excerptEnd !== undefined) setPaused(previous => ({ ...previous, [id]: true }))
      },
      onError(cause) {
        pauseDeck(id)
        rejectKeyLock(id, cause)
      },
    })
    updatePosition(id, carryPosition ? sources.position(id) ?? offset : offset)
    setPaused(previous => ({ ...previous, [id]: false }))
    setPlaying(previous => ({ ...previous, [id]: true }))
  }

  function pauseDeck(id: DeckId) {
    delete hotCuePresses.current[id]
    discardScrub(id)
    playVersion.current[id]++
    startPending.current[id] = false
    delete excerptEnds.current[id]
    setStarting(previous => ({ ...previous, [id]: false }))
    const stoppedAt = sources.pause(id)
    if (stoppedAt !== undefined) {
      updatePosition(id, stoppedAt)
      checkpoint(id, stoppedAt)
      setPaused(previous => ({ ...previous, [id]: true }))
    }
    setPlaying(previous => ({ ...previous, [id]: false }))
  }

  function pause(target: PlayMode) {
    for (const id of target === "both" ? deckIds : [target]) pauseDeck(id)
  }

  function stop(remember: boolean) {
    pause("both")
    if (remember) return
    for (const id of deckIds) {
      const at = startPosition(decksRef.current[id])
      updatePosition(id, at)
      checkpoint(id, at)
    }
    setPaused(flagsOff())
  }

  function reposition(id: DeckId, offset: number) {
    if (sources.has(id)) {
      const keyLock = activeKeyLock(id)
      try {
        beginSource(id, offset, output().context.currentTime + .008, keyLock)
      } catch (cause) {
        pauseDeck(id)
        if (keyLock) rejectKeyLock(id, cause)
        else setError("The deck could not jump to this position.")
      }
    }
    updatePosition(id, offset)
  }

  function seek(id: DeckId, seconds: number) {
    const { track, loop, loopArmed } = decksRef.current[id]
    if (!track || !Number.isFinite(seconds)) return
    delete hotCuePresses.current[id]
    discardScrub(id)
    delete excerptEnds.current[id]
    const target = boundedPosition(track, seconds)
    if (loop && (target >= loop.end || (!loopArmed && target < loop.start))) {
      updateDeck(id, { loop: null, loopArmed: false })
    }
    reposition(id, target)
    checkpoint(id, target)
  }

  function pressHotCue(id: DeckId, seconds: number, mode: Exclude<HotCueMode, "instant">) {
    const { track, loading } = decksRef.current[id]
    if (!track || loading || !Number.isFinite(seconds)) return undefined

    if (mode === "release") pauseDeck(id)
    seek(id, seconds)
    if (mode === "hold") void play(id)
    const token = Symbol()
    hotCuePresses.current[id] = token

    return (reason: HotCueGestureEnd) => {
      if (hotCuePresses.current[id] !== token) return
      delete hotCuePresses.current[id]
      if (decksRef.current[id].track !== track || decksRef.current[id].loading) return
      if (mode === "hold") {
        pauseDeck(id)
        seek(id, seconds)
        setPaused(previous => ({ ...previous, [id]: true }))
      } else if (reason === "release") void play(id)
    }
  }

  function discardScrub(id: DeckId, immediate = false) {
    const scrub = scrubs.current[id]
    if (!scrub) return undefined
    delete scrubs.current[id]
    scrubSources.pause(id, immediate)
    return scrub
  }

  function beginScrub(id: DeckId, seconds: number): boolean {
    const { track, loading } = decksRef.current[id]
    if (!track || loading || startPending.current[id] || !Number.isFinite(seconds)) return false
    delete hotCuePresses.current[id]
    discardScrub(id)
    const running = sources.has(id)
    scrubs.current[id] = { track, running, origin: getPositions()[id], position: seconds, excerptEnd: excerptEnds.current[id] }
    if (running) delete excerptEnds.current[id]
    updateScrub(id, seconds)
    return true
  }

  function playScrubPreview(id: DeckId, scrub: WaveScrub) {
    const deck = decksRef.current[id]
    const { buffer } = scrub.track
    const { position } = scrub
    // Negative positions belong to the silent pre-roll of the deck.
    if (position < 0) { scrubSources.pause(id); return }
    const { context, decks: outputDecks } = output()
    const excerptEnd = Math.min(buffer.duration, position + .105)
    if (excerptEnd <= position) return
    scrubSources.start(id, {
      buffer, context, destination: outputDecks[id].input, offset: position, startAt: context.currentTime + .008,
      excerptEnd, speed: 1, loop: null, eq: deck.eq, pan: deck.pan, filter: deck.filter,
      stems: stemBanks.current[id], stemLevels: deck.stemLevels,
      level: trimGain(deck.gainDb), onEnd() {},
    })
  }

  function updateScrub(id: DeckId, seconds: number) {
    const scrub = scrubs.current[id]
    if (!scrub || scrub.track !== decksRef.current[id].track || !Number.isFinite(seconds)) return
    scrub.position = boundedPosition(scrub.track, seconds)
    if (scrub.previewFailed) return
    const fail = (cause: unknown) => {
      if (scrubs.current[id] !== scrub) return
      scrub.previewFailed = true
      recordDiagnostic("warn", "audio.scrub.preview_failed", { deck: id, ...diagnosticError(cause) })
    }
    try {
      const { context } = output()
      if (scrub.running) beginSource(id, scrub.position, context.currentTime + .008, activeKeyLock(id))
      else if (context.state === "running") playScrubPreview(id, scrub)
      else if (scrub.position >= 0 && !scrub.resumePending) {
        scrub.resumePending = true
        void context.resume().then(() => {
          if (scrubs.current[id] !== scrub) return
          scrub.resumePending = false
          playScrubPreview(id, scrub)
        }).catch(fail)
      }
    } catch (cause) { fail(cause) }
  }

  function endScrub(id: DeckId, seconds?: number) {
    const scrub = discardScrub(id)
    if (!scrub || decksRef.current[id].track !== scrub.track) return
    const committed = seconds !== undefined && Number.isFinite(seconds)
    const position = committed ? boundedPosition(scrub.track, seconds) : scrub.origin
    const needsRestart = scrub.running && !sources.has(id)
    if (committed) seek(id, position)
    else if (scrub.running) {
      if (scrub.excerptEnd !== undefined && position < scrub.excerptEnd) excerptEnds.current[id] = scrub.excerptEnd
      reposition(id, position)
    }
    if (needsRestart) {
      try { beginSource(id, position, output().context.currentTime + .008, activeKeyLock(id)) }
      catch (cause) {
        recordDiagnostic("warn", "audio.scrub.resume_failed", { deck: id, ...diagnosticError(cause) })
        setError(`Deck ${id} could not resume after scrubbing.`)
      }
    }
  }

  function setLoop(id: DeckId, range: DeckLoop | null, startAtIn = false): boolean {
    const { track, loop, loopArmed, loading } = decksRef.current[id]
    if (!track || loading || (range && !validLoop(range, track.buffer.duration))) return false
    discardScrub(id)
    if (excerptEnds.current[id] === undefined && !loopArmed && !startAtIn
      && range?.start === loop?.start && range?.end === loop?.end) return true
    delete excerptEnds.current[id]
    const position = boundedPosition(track, getPositions()[id])
    updateDeck(id, { loop: range, loopArmed: false })
    const target = range && (startAtIn || position < range.start || position >= range.end) ? range.start : position
    reposition(id, target)
    checkpoint(id, target)
    return true
  }

  function armLoop(id: DeckId, range: DeckLoop): boolean {
    const { track, loop, loading } = decksRef.current[id]
    if (!track || loop || loading || !validLoop(range, track.buffer.duration)) return false
    if (getPositions()[id] >= range.end) return false
    if (excerptEnds.current[id] === undefined && sources.has(id) && !sources.armLoop(id, range)) return false
    updateDeck(id, { loop: range, loopArmed: true })
    return true
  }

  function change(id: DeckId, field: "start" | "speed", value: string) {
    const track = decksRef.current[id].track
    const number = Number(value)
    if (field === "start" && track && value.trim() && Number.isFinite(number)) {
      const at = boundedPosition(track, number)
      updateDeck(id, { start: at !== number ? String(at) : value })
      seek(id, at)
      return
    }
    updateDeck(id, { [field]: value })
    if (!value.trim() || !Number.isFinite(number)) return
    if (field === "speed" && validSpeed(number)) sources.setSpeed(id, number / 100)
  }

  function setSpeed(id: DeckId, percent: number, offset?: number): boolean {
    const { track, loading } = decksRef.current[id]
    if (!track || loading || !validSpeed(percent) || (offset !== undefined && !Number.isFinite(offset))) return false
    if (offset === undefined) change(id, "speed", String(percent))
    else {
      updateDeck(id, { speed: String(percent) })
      seek(id, offset)
    }
    return true
  }

  async function audition(id: DeckId, start: number, end: number, behavior: AuditionBehavior, loopStart = start) {
    const deck = decksRef.current[id]
    const { track, loading } = deck
    if (!track || loading || !Number.isFinite(start) || (!sources.has(id) && !validSettings(deck))) return
    delete hotCuePresses.current[id]
    discardScrub(id)
    if (behavior === "continue") {
      seek(id, start)
    } else {
      const offset = boundedPosition(track, start)
      const limit = Math.min(track.buffer.duration, end)
      if (!Number.isFinite(end) || !(limit > offset)) return
      const loop = behavior === "loop" && Number.isFinite(loopStart)
        ? { start: Math.max(0, boundedPosition(track, loopStart)), end: limit }
        : null
      if (loop && validLoop(loop, track.buffer.duration)) {
        delete excerptEnds.current[id]
        updateDeck(id, { loop, loopArmed: false })
      } else {
        excerptEnds.current[id] = limit
      }
      reposition(id, offset)
    }
    if (!sources.has(id)) await play(id)
  }

  function commitTrack(id: DeckId, track: TransitionTrack, startSeconds: number, options?: { pausedAt: number }) {
    checkBuffer(track.buffer)
    const previousBank = sameStemSource(track, decksRef.current[id].track) ? stemBanks.current[id] : undefined
    releaseKeyLock(id)
    releaseStems(id)
    const start = boundedPosition(track, Number.isFinite(startSeconds) ? startSeconds : 0)
    const { eq, gainDb, pan, filter, fx } = decksRef.current[id]
    updateDeck(id, { ...emptyDeck(eq, { gainDb, pan, filter, fx }), track, start: String(start) })
    const pausedAt = options && clampTrackTime(options.pausedAt, track.buffer.duration)
    updatePosition(id, pausedAt ?? start)
    setPaused(previous => ({ ...previous, [id]: Boolean(options) }))
    if (!options && keyLockPreference.current[id]) void setKeyLock(id, true)
    void loadStemBank(id, true, previousBank)
  }

  function loadDecoded(id: DeckId, track: TransitionTrack, startSeconds = 0) {
    pauseDeck(id)
    loadVersion.current[id]++
    setRestoring(previous => ({ ...previous, [id]: false }))
    try {
      commitTrack(id, track, startSeconds)
      void saveTrack(id, track, cacheGeneration.current)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "This track could not be loaded."
      updateDeck(id, { loading: false, error: message })
    }
  }

  async function decodeFile(file: File, isCurrent: () => boolean, fileBytes?: ArrayBuffer): Promise<TransitionTrack | null> {
    if (!file.size || file.size > MAX_LIBRARY_FILE_BYTES) throw new Error(LIBRARY_FILE_SIZE_MESSAGE)
    const bytes = fileBytes ?? await file.arrayBuffer()
    if (!isCurrent()) return null
    const { context } = output()
    const buffer = await context.decodeAudioData(bytes)
    if (!isCurrent()) return null
    const name = file.name.replace(/\.[^.]+$/, "") || file.name
    return { name, buffer, file }
  }

  async function decodeForPreparation(file: File, signal: AbortSignal): Promise<AudioBuffer> {
    signal.throwIfAborted()
    const decoded = await decodeFile(file, () => !signal.aborted)
    signal.throwIfAborted()
    if (!decoded) throw new Error("This library track could not be decoded.")
    return decoded.buffer
  }

  function libraryWriteFailure(event: string, cause: unknown, id?: DeckId) {
    recordDiagnostic("warn", event, { deck: id ?? null, ...diagnosticError(cause) })
    if (!mounted.current) return
    if (cause instanceof RangeError) setLibraryNotice(LIBRARY_FILE_SIZE_MESSAGE)
    else if (cause instanceof DOMException && cause.name === "QuotaExceededError") {
      setLibraryNotice("Browser storage is full. Studio can still play files without adding them to the library.")
    } else {
      setLibraryNotice("Studio couldn’t save a local library copy. The original file is still available to open directly.")
    }
  }

  async function decodeOpenedFile(id: DeckId, file: File, isCurrent: () => boolean): Promise<TransitionTrack | null> {
    if (!file.size || file.size > MAX_LIBRARY_FILE_BYTES) throw new Error(LIBRARY_FILE_SIZE_MESSAGE)
    const bytes = await file.arrayBuffer()
    if (!isCurrent()) return null
    let fingerprint: string | undefined
    try { fingerprint = await identifyLibraryTrack(bytes) }
    catch (cause) { libraryWriteFailure("storage.library.fingerprint_failed", cause, id) }
    if (!isCurrent()) return null
    const retention = fingerprint ? addLibraryFile(file, fingerprint).catch(cause => {
      libraryWriteFailure("storage.library.add_failed", cause, id)
      return null
    }) : null
    const [track, retained] = await Promise.all([decodeFile(file, isCurrent, bytes), retention])
    if (!track || !isCurrent()) return null
    track.fingerprint = fingerprint
    if (retained) {
      track.libraryId = retained.entry.id
      applyCachedSidecar(id, track, await readLibraryPrep(id, retained.entry.id))
    }
    return isCurrent() ? track : null
  }

  async function decodeLibraryTrack(id: DeckId, libraryId: string, isCurrent: () => boolean): Promise<TransitionTrack | null> {
    const stored = await openLibraryFile(libraryId)
    if (!isCurrent()) return null
    if (!stored) throw new Error("This track is no longer in the local library.")
    const [track, prep] = await Promise.all([decodeFile(stored.file, isCurrent), readLibraryPrep(id, libraryId)])
    if (!track || !isCurrent()) return null
    track.libraryId = libraryId
    applyCachedSidecar(id, track, prep)
    return track
  }

  async function loadFile(id: DeckId, file: File) {
    if (!file.size || file.size > MAX_LIBRARY_FILE_BYTES) {
      updateDeck(id, { error: LIBRARY_FILE_SIZE_MESSAGE })
      return
    }
    pauseDeck(id)
    cancelStemPreparation(id)
    const version = ++loadVersion.current[id]
    const generation = cacheGeneration.current
    setRestoring(previous => ({ ...previous, [id]: false }))
    setLibraryNotice(null)
    updateDeck(id, { loading: true, error: null })
    try {
      const track = await decodeOpenedFile(id, file, () => version === loadVersion.current[id])
      if (!track || version !== loadVersion.current[id]) return
      commitTrack(id, track, 0)
      recordDiagnostic("info", "audio.decode.ready", { deck: id, duration: track.buffer.duration, channels: track.buffer.numberOfChannels })
      await saveTrack(id, track, generation)
    } catch (cause) {
      if (version !== loadVersion.current[id]) return
      recordDiagnostic("error", "audio.decode.failed", { deck: id, ...diagnosticError(cause) })
      const message = cause instanceof Error && cause.name === "Error"
        ? cause.message : "Couldn’t decode this file. Try a WAV or MP3."
      updateDeck(id, { loading: false, error: message })
    }
  }

  async function addLibraryTracks(files: Iterable<File>) {
    setLibraryNotice(null)
    const { added, existing, relinked, failed, skipped, lastError } = await addLibraryFiles(files)
    recordDiagnostic("info", "storage.library.imported", { added, existing, relinked, failed, skipped })
    if (failed) libraryWriteFailure("storage.library.import_failed", lastError)
    return { added, existing, relinked, failed, skipped }
  }

  async function loadLibraryTrack(id: DeckId, libraryId: string): Promise<boolean> {
    pauseDeck(id)
    cancelStemPreparation(id)
    const version = ++loadVersion.current[id]
    const generation = cacheGeneration.current
    const current = () => loadVersion.current[id] === version
    setRestoring(previous => ({ ...previous, [id]: false }))
    setLibraryNotice(null)
    updateDeck(id, { loading: true, error: null })
    try {
      const track = await decodeLibraryTrack(id, libraryId, current)
      if (!track || !current()) return false
      commitTrack(id, track, 0)
      recordDiagnostic("info", "storage.library.opened", { deck: id })
      await saveTrack(id, track, generation)
      return current()
    } catch (cause) {
      if (!current()) return false
      recordDiagnostic("warn", "storage.library.open_failed", { deck: id, ...diagnosticError(cause) })
      const message = `Couldn’t open that library track on Deck ${id}. The previous track is still available if one was loaded.`
      updateDeck(id, { loading: false, error: message })
      setLibraryNotice(message)
      return false
    }
  }

  async function removeLibraryTrack(libraryId: string): Promise<boolean> {
    setLibraryNotice(null)
    try {
      await deleteLibraryTrack(libraryId)
      recordDiagnostic("info", "storage.library.removed")
      return true
    } catch (cause) {
      recordDiagnostic("warn", "storage.library.remove_failed", diagnosticError(cause))
      setLibraryNotice("Studio couldn’t remove the selected library copy.")
      return false
    }
  }

  function setCrossfader(value: number) {
    const slider = normalizeFaderPosition(value)
    faderRef.current = slider
    setFader(slider)
    updateCrossfader()
  }

  function faderGain(id: DeckId) {
    return getCrossfaderGain(id, faderRef.current, curveRef.current, customCurveRef.current)
  }

  function updateCrossfader() {
    const mix = outputRef.current
    if (!mix) return
    const now = mix.context.currentTime
    const { A, B } = decksRef.current
    const active = mix.context.state === "running" && (sources.has("A") || sources.has("B") || A.fx.enabled || B.fx.enabled)
    for (const id of deckIds) {
      const gain = mix.decks[id].fader.gain
      gain.cancelScheduledValues(now)
      const value = faderGain(id)
      if (active) gain.setTargetAtTime(value, now, .008)
      else gain.setValueAtTime(value, now)
    }
  }

  function storeMixer() {
    const { A, B } = decksRef.current
    const preferences = {
      gains: { A: A.gainDb, B: B.gainDb }, pan: { A: A.pan, B: B.pan }, filter: { A: A.filter, B: B.filter },
      curve: curveRef.current, customCurve: customCurveRef.current, keyLock: keyLockPreference.current,
      masterDb: masterDbRef.current, fx: { A: A.fx, B: B.fx },
    }
    try { localStorage.setItem(mixerStorageKey, JSON.stringify(preferences)) } catch { /* Storage is optional. */ }
  }

  function setGain(id: DeckId, gainDb: number) {
    const normalized = normalizeGainDb(gainDb)
    updateDeck(id, { gainDb: normalized })
    sources.setLevel(id, trimGain(normalized))
    storeMixer()
  }

  function setMasterDb(value: number) {
    const db = normalizeMasterDb(value)
    masterDbRef.current = db
    setMasterLevel(db)
    outputRef.current?.setMasterDb(db)
    storeMixer()
  }

  function setFx(id: DeckId, patch: Partial<DeckFxSettings>) {
    const fx = normalizeDeckFx({ ...decksRef.current[id].fx, ...patch })
    updateDeck(id, { fx })
    outputRef.current?.decks[id].effects.update(fx)
    storeMixer()
  }

  function setPan(id: DeckId, value: number) {
    const pan = normalizePan(value)
    updateDeck(id, { pan })
    sources.setPan(id, pan)
    storeMixer()
  }

  function setFilter(id: DeckId, value: number) {
    const filter = normalizeFilter(value)
    updateDeck(id, { filter })
    sources.setFilter(id, filter)
    storeMixer()
  }

  function setCurve(value: CrossfaderCurve) {
    if (!isCrossfaderCurve(value)) return
    curveRef.current = value
    setSelectedCurve(value)
    updateCrossfader()
    storeMixer()
  }

  function setCustomCurve(value: CrossfaderCustom) {
    const custom = normalizeCrossfaderCustom(value)
    customCurveRef.current = custom
    setSelectedCustomCurve(custom)
    updateCrossfader()
    storeMixer()
  }

  function activeKeyLock(id: DeckId) {
    return decksRef.current[id].keyLock ? lockSource.current[id] : undefined
  }

  function releaseKeyLock(id: DeckId) {
    keyLockVersion.current[id]++
    delete lockPreparation.current[id]
    lockSource.current[id]?.dispose()
    delete lockSource.current[id]
  }

  function rejectKeyLock(id: DeckId, cause: unknown) {
    recordDiagnostic("warn", "audio.key_lock.failed", { deck: id, ...diagnosticError(cause) })
    releaseKeyLock(id)
    keyLockPreference.current[id] = false
    const message = cause instanceof Error ? cause.message : "Key Lock could not start."
    updateDeck(id, { keyLock: false, keyLockPending: false, keyLockError: message })
    storeMixer()
  }

  function keyLockLead(source?: KeyLockSource) {
    return .025 + (source?.latency ?? 0)
  }

  function handoffSource(id: DeckId, source?: KeyLockSource) {
    const { track } = decksRef.current[id]
    if (track && sources.has(id)) {
      const at = output().context.currentTime + keyLockLead(source)
      const position = sources.positionAt(id, at) ?? positionRef.current[id]
      beginSource(id, boundedPosition(track, position), at, source, true)
    }
  }

  function releaseStems(id: DeckId) {
    stemRequests.current[id]?.abort()
    delete stemRequests.current[id]
    delete stemBanks.current[id]
    delete stemHandoffs.current[id]
  }

  function cancelStemPreparation(id: DeckId) {
    if (!stemRequests.current[id]) return
    stemRequests.current[id]!.abort()
    delete stemRequests.current[id]
    updateDeck(id, { stemsStatus: "idle", stemsError: null })
  }

  async function loadStemBank(id: DeckId, cacheOnly = false, previousBank?: DeckStemBank) {
    const { track, loading } = decksRef.current[id]
    const fingerprint = stemFingerprint(track)
    if (!track?.file || loading || stemRequests.current[id] || stemBanks.current[id] || !withinStemMemoryLimit(track.buffer)
      || (cacheOnly && !fingerprint)) return false
    const request = new AbortController()
    stemRequests.current[id] = request
    updateDeck(id, { stemsStatus: cacheOnly ? "restoring" : "preparing", stemsError: null })
    const current = () => stemRequests.current[id] === request && decksRef.current[id].track === track
    try {
      const { context } = output()
      const other = id === "A" ? "B" : "A"
      const sharedBank = sameStemSource(track, decksRef.current[other].track) ? stemBanks.current[other] : undefined
      const cachedBank = previousBank ?? sharedBank ?? (fingerprint && await readStemCache(context, track.buffer, fingerprint, request.signal)
        .catch(error => {
          request.signal.throwIfAborted()
          recordDiagnostic("warn", "audio.stems.cache_read_failed", { deck: id, ...diagnosticError(error) })
          return null
        }))
      if (!current()) return false
      if (cacheOnly && !cachedBank) {
        updateDeck(id, { stemsStatus: "idle" })
        return false
      }
      const bank = cachedBank || await queueLocalPreparation(() => {
        request.signal.throwIfAborted()
        return fetchDeckStems(context, track.buffer, request.signal, fingerprint)
      })
      await lockPreparation.current[id]
      if (!current()) return false
      const install = async () => {
        const previous = lockSource.current[id]
        const lock = activeKeyLock(id) && await prepareKeyLockSource(context, track.buffer, bank, request.signal)
        if (!current()) { lock?.dispose(); return }
        stemBanks.current[id] = bank
        try {
          handoffSource(id, lock)
        } catch (error) {
          delete stemBanks.current[id]
          lock?.dispose()
          throw error
        }
        if (lock) lockSource.current[id] = lock
        else delete lockSource.current[id]
        if (previous) setTimeout(() => previous.dispose(), (keyLockLead(lock) + .08) * 1000)
        updateDeck(id, { stemsStatus: "ready", stemLevels: FULL_STEM_LEVELS, stemsError: null })
        recordDiagnostic("info", "audio.stems.ready", { deck: id, duration: track.buffer.duration, cached: Boolean(cachedBank) })
        if (!cachedBank && sameStemSource(track, decksRef.current[other].track)) void loadStemBank(other, true, bank)
      }
      const handoff = install()
      stemHandoffs.current[id] = handoff
      try { await handoff }
      finally { if (stemHandoffs.current[id] === handoff) delete stemHandoffs.current[id] }
      return current()
    } catch (cause) {
      if (!current()) return false
      recordDiagnostic("warn", "audio.stems.failed", { deck: id, ...diagnosticError(cause) })
      updateDeck(id, { stemsStatus: "error", stemsError: cause instanceof Error ? cause.message : "Stem preparation failed." })
      return false
    } finally {
      if (stemRequests.current[id] === request) delete stemRequests.current[id]
    }
  }

  function setStemLevel(id: DeckId, stem: DeckStem, percent: number) {
    const deck = decksRef.current[id]
    if (deck.stemsStatus !== "ready" || deck.loading || !Number.isFinite(percent)) return
    const level = Math.min(100, Math.max(0, percent))
    if (level === deck.stemLevels[stem]) return
    const levels = { ...deck.stemLevels, [stem]: level }
    sources.setStemLevels(id, levels)
    scrubSources.setStemLevels(id, levels)
    updateDeck(id, { stemLevels: levels })
  }

  function canPrepareStems(id: DeckId) {
    const { track, loading } = decksRef.current[id]
    return Boolean(track?.file && !loading && withinStemMemoryLimit(track.buffer))
  }

  async function setKeyLock(id: DeckId, enabled: boolean): Promise<boolean> {
    const handoff = stemHandoffs.current[id]
    if (handoff) {
      const track = decksRef.current[id].track
      await handoff.catch(() => {})
      if (track !== decksRef.current[id].track) return false
    }
    const { track, keyLock, loading } = decksRef.current[id]
    if (!track || loading) return false
    if (!enabled) {
      if (keyLock) {
        try { handoffSource(id) } catch {
          updateDeck(id, { keyLockError: "The deck could not switch playback mode." })
          return false
        }
      }
      keyLockVersion.current[id]++
      delete lockPreparation.current[id]
      keyLockPreference.current[id] = false
      updateDeck(id, { keyLock: false, keyLockPending: false, keyLockError: null })
      storeMixer()
      return true
    }
    if (keyLock) return true
    if (lockPreparation.current[id]) return lockPreparation.current[id]
    if (!keyLockAvailable) {
      rejectKeyLock(id, new Error("Key Lock requires AudioWorklet support in this browser."))
      return false
    }

    const version = ++keyLockVersion.current[id]
    updateDeck(id, { keyLockPending: true, keyLockError: null })
    const prepare = async () => {
      try {
        const { context } = output()
        await context.resume()
        if (keyLockVersion.current[id] !== version) return false
        const existing = lockSource.current[id]
        const source = existing ?? await prepareKeyLockSource(context, track.buffer, stemBanks.current[id])
        if (keyLockVersion.current[id] !== version) {
          if (!existing) source.dispose()
          return false
        }
        lockSource.current[id] = source
        handoffSource(id, source)
        keyLockPreference.current[id] = true
        updateDeck(id, { keyLock: true, keyLockPending: false, keyLockError: null })
        storeMixer()
        return true
      } catch (cause) {
        if (keyLockVersion.current[id] === version) rejectKeyLock(id, cause)
        return false
      } finally {
        if (keyLockVersion.current[id] === version) delete lockPreparation.current[id]
      }
    }
    const pending = prepare()
    lockPreparation.current[id] = pending
    return pending
  }

  function storeEq() {
    try {
      localStorage.setItem(eqStorageKey, JSON.stringify({ A: decksRef.current.A.eq, B: decksRef.current.B.eq }))
    } catch { /* Storage is optional. */ }
  }

  function setEq(id: DeckId, band: EqBand, db: number) {
    const value = normalizeEqDb(db)
    const next = { ...decksRef.current[id].eq, [band]: value }
    updateDeck(id, { eq: next })
    sources.setBand(id, band, value)
    storeEq()
  }

  function resetEq(id: DeckId) {
    const next = flatEq()
    updateDeck(id, { eq: next })
    for (const band of EQ_BANDS) sources.setBand(id, band, next[band])
    storeEq()
  }

  function loadDemo() {
    stop(false)
    loadVersion.current.A++
    loadVersion.current.B++
    setRestoring(flagsOff())
    setError(null)
    try {
      const buffer = createDemoBuffer(output().context)
      const a = { name: "Night Signal · Drop", buffer, demo: true }
      const b = { name: "Night Signal · Intro", buffer, demo: true }
      commitTrack("A", a, 16)
      commitTrack("B", b, 0)
      void saveTrack("A", a, cacheGeneration.current)
      void saveTrack("B", b, cacheGeneration.current)
      setCrossfader(0)
    } catch (cause) {
      recordDiagnostic("warn", "audio.demo.failed", diagnosticError(cause))
      setError("Generated audio could not be loaded in this browser.")
    }
  }

  function readyToStart(id: DeckId) {
    return validSettings(decksRef.current[id]) && !sources.has(id) && !startPending.current[id]
  }

  function canPlay(target: PlayMode) {
    return target === "both"
      ? deckIds.every(id => validSettings(decksRef.current[id])) && deckIds.some(readyToStart)
      : readyToStart(target)
  }

  async function prepareControllerPlayback() {
    // MIDI messages do not carry the browser activation of a UI click.
    try { await output().context.resume() }
    catch (cause) { recordDiagnostic("warn", "audio.midi.resume_failed", diagnosticError(cause)) }
  }

  async function play(target: PlayMode) {
    if (!canPlay(target)) return
    const requested = (target === "both" ? deckIds : [target]).filter(readyToStart)
    const tickets = requested.map(id => ({ id, version: ++playVersion.current[id] }))
    for (const id of requested) {
      delete hotCuePresses.current[id]
      discardScrub(id)
      startPending.current[id] = true
      setStarting(previous => ({ ...previous, [id]: true }))
    }
    setError(null)
    try {
      const { context } = output()
      await context.resume()
      await Promise.all(tickets.map(({ id, version }) => {
        if (playVersion.current[id] !== version) return
        return lockPreparation.current[id]
          ?? (keyLockPreference.current[id] && !decksRef.current[id].keyLock ? setKeyLock(id, true) : undefined)
      }))
      const startAt = context.currentTime + Math.max(...tickets.map(({ id }) => keyLockLead(activeKeyLock(id))))
      for (const { id, version } of tickets) {
        if (playVersion.current[id] !== version) continue
        const deck = decksRef.current[id]
        if (!deck.track || !validSettings(deck)) continue
        const position = positionRef.current[id]
        const keyLock = activeKeyLock(id)
        try {
          beginSource(id, position < deck.track.buffer.duration ? position : startPosition(deck), startAt, keyLock)
        } catch (cause) {
          if (keyLock) rejectKeyLock(id, cause)
          else {
            recordDiagnostic("error", "audio.play.deck_failed", { deck: id, ...diagnosticError(cause) })
            setError(`Deck ${id} could not start. Try loading the audio again.`)
          }
        }
      }
    } catch (cause) {
      if (tickets.some(({ id, version }) => playVersion.current[id] === version)) {
        recordDiagnostic("error", "audio.play.failed", { target, ...diagnosticError(cause) })
        setError("Playback could not start. Try loading the audio again.")
      }
    } finally {
      for (const { id, version } of tickets) {
        if (playVersion.current[id] !== version) continue
        if (!sources.has(id)) delete excerptEnds.current[id]
        startPending.current[id] = false
        setStarting(previous => ({ ...previous, [id]: false }))
      }
    }
  }

  const restoreStatus: RestoreStatus = restoring.A || restoring.B ? "restoring" : storageUnavailable ? "unavailable" : "ready"
  return {
    decks, positions, getPositions, getLevels, fader, playing, starting, paused, mode, error, curve, customCurve, masterDb, keyLockAvailable,
    isStarting: starting.A || starting.B, pausedMode: playMode(paused),
    loadFile, loadDecoded, setCrossfader, setEq, resetEq, setGain, setPan, setFilter, setCurve, setCustomCurve, setSpeed, setKeyLock,
    setMasterDb, setFx,
    canPrepareStems, prepareStems: (id: DeckId) => loadStemBank(id), cancelStemPreparation, setStemLevel,
    restoring, restoreStatus, restoreNotice, clearSavedTracks, saveTrackSidecar,
    library, libraryStatus, libraryNotice, addLibraryTracks, loadLibraryTrack, removeLibraryTrack, decodeForPreparation,
    loadDemo, canPlay, play, pause, prepareControllerPlayback, seek, pressHotCue, beginScrub, updateScrub, endScrub, audition, setLoop, armLoop, stop, change,
  }
}
