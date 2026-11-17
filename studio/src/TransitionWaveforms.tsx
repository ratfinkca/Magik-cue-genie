import { CaretDownIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react"
import { manualBeatTicks } from "./beatGrid"
import type { ManualBeatGrid } from "./beatGrid"
import { formatTime } from "./cues"
import type { Cue } from "./cues"
import { cueIdentity } from "./cuePreparation"
import { createHotCueGesture } from "./hotCueGesture"
import type { HotCueFinish, HotCueInput, HotCueMode } from "./hotCueGesture"
import { getLoop } from "./loops"
import { clampPerformanceLoopEdge, movePerformanceLoop, performanceLoopEdgeLimits } from "./performanceLoop"
import type { LoopEdge } from "./performanceLoop"
import type { QuantizeMode } from "./quantize"
import { displayCueColor } from "./studioPreferences"
import type { CueColors } from "./studioPreferences"
import { MIN_TRACK_SECONDS } from "./trackTime"
import { createEqResponseReader } from "./transitionEq"
import type { EqSettings } from "./transitionEq"
import { buildWaveform, drawWaveform, timelineStep } from "./waveform"
import type { WaveformData, WaveformMode } from "./waveform"
import { estimateBeatGrid, timelineGridTicks } from "./waveformTimeline"
import type { TimelineBeat, TimelineGrid } from "./waveformTimeline"
import "./transitionWaveforms.css"

const decks = ["A", "B"] as const
const noCues: readonly Cue[] = []
type DeckId = typeof decks[number]
type DeskClock = Record<DeckId, number>
type Span = 2 | 4 | 8 | 16 | 32
type Loop = { start: number; end: number }
type PressCue = (id: DeckId, index: number, mode: Exclude<HotCueMode, "instant">) => HotCueFinish | undefined

export type TransitionWaveformsProps = {
  tracks: Partial<Record<DeckId, AudioBuffer>>
  names?: Partial<Record<DeckId, string>>
  positions: DeskClock
  speeds: Record<DeckId, number>
  isPlaying: boolean
  getPositions: () => DeskClock
  seek?: (id: DeckId, seconds: number) => void
  beginScrub?: (id: DeckId, seconds: number) => boolean
  updateScrub?: (id: DeckId, seconds: number) => void
  endScrub?: (id: DeckId, seconds?: number) => void
  cues?: Partial<Record<DeckId, readonly Cue[]>>
  cueColors?: CueColors
  beatTimes?: Partial<Record<DeckId, readonly number[]>>
  predictedBeatGrid?: Partial<Record<DeckId, boolean>>
  manualBeatGrid?: Partial<Record<DeckId, ManualBeatGrid | null>>
  bpm?: Partial<Record<DeckId, number | null>>
  loops?: Partial<Record<DeckId, Loop | null>>
  selectedCues?: Partial<Record<DeckId, number | null>>
  selectCue?: (id: DeckId, index: number) => void
  triggerCue?: (id: DeckId, index: number) => void
  hotCueMode?: HotCueMode
  pressCue?: PressCue
  createLoop?: (id: DeckId, startSeconds: number, endSeconds: number) => void
  trimLoop?: (id: DeckId, range: Loop) => void
  loopBeatTimes?: Partial<Record<DeckId, readonly number[]>>
  loopQuantize?: QuantizeMode
  pendingLoopIns?: Partial<Record<DeckId, number | null>>
  loopEditor?: ReactNode
  eq?: Partial<Record<DeckId, EqSettings>>
  gainDb?: Partial<Record<DeckId, number>>
  filter?: Partial<Record<DeckId, number>>
  toolbar?: ReactNode
  onWaveformReady?: (id: DeckId, buffer: AudioBuffer, waveform: WaveformData) => void
}

const viewModes: { id: WaveformMode; label: string }[] = [
  { id: "rgb", label: "RGB" },
  { id: "bands", label: "Tri-band" },
  { id: "split", label: "Split" },
]
const prefsKey = "magik.studio.waveforms.v1"
const spans: Span[] = [2, 4, 8, 16, 32]
const grids: Record<TimelineGrid, string> = { seconds: "Seconds", beats: "Beats", bars: "Bars" }
const gridModes = Object.keys(grids) as TimelineGrid[]
const meters = Array.from({ length: 15 }, (_, index) => index + 2)

type GridLayers = Record<TimelineGrid, boolean>
type WaveformPreferences = { mode: WaveformMode; span: Span; eqOverlay: boolean; gridLayers: GridLayers; meter: number }

function readPreferences(): WaveformPreferences {
  const defaults: WaveformPreferences = {
    mode: "rgb", span: 8, eqOverlay: false, gridLayers: { seconds: true, beats: true, bars: false }, meter: 4,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(prefsKey) ?? "null")
    if (!saved || typeof saved !== "object") return defaults
    return {
      mode: viewModes.find(item => item.id === saved.mode)?.id ?? defaults.mode,
      span: spans.find(item => item === saved.span) ?? defaults.span,
      eqOverlay: saved.eqOverlay === true,
      gridLayers: {
        seconds: typeof saved.gridLayers?.seconds === "boolean" ? saved.gridLayers.seconds : defaults.gridLayers.seconds,
        beats: typeof saved.gridLayers?.beats === "boolean" ? saved.gridLayers.beats : defaults.gridLayers.beats,
        bars: typeof saved.gridLayers?.bars === "boolean" ? saved.gridLayers.bars : defaults.gridLayers.bars,
      },
      meter: meters.find(meter => meter === saved.meter) ?? defaults.meter,
    }
  } catch {
    return defaults
  }
}

function useWaveform(buffer?: AudioBuffer) {
  const [result, setResult] = useState<{ buffer: AudioBuffer; waveform: WaveformData | null }>()
  useEffect(() => {
    setResult(undefined)
    if (!buffer) return
    const controller = new AbortController()
    void buildWaveform(buffer, controller.signal).then(
      waveform => { if (!controller.signal.aborted) setResult({ buffer, waveform }) },
      () => { if (!controller.signal.aborted) setResult({ buffer, waveform: null }) },
    )
    return () => controller.abort()
  }, [buffer])
  return result?.buffer === buffer ? result?.waveform : undefined
}

function playbackRate(speed: number) {
  return Number.isFinite(speed) && speed >= 50 && speed <= 200 ? speed / 100 : 1
}

function clampPosition(time: number, duration: number, start = MIN_TRACK_SECONDS) {
  return Math.max(start, Math.min(Number.isFinite(time) ? time : 0, duration))
}

function lastPlayableTime(track: AudioBuffer) {
  return Math.max(0, track.duration - Math.max(.001, 1 / track.sampleRate))
}

function ChannelOverlay({ settings, gainDb, filter, sampleRate, id }: {
  settings: EqSettings; gainDb: number; filter: number; sampleRate: number; id: DeckId
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reader = useRef<ReturnType<typeof createEqResponseReader> | undefined>(undefined)
  const highFrequency = Math.min(16_000, Math.round(sampleRate * .48))
  useLayoutEffect(() => {
    const values = Float32Array.from({ length: 80 }, (_, index) => 50 * Math.pow(highFrequency / 50, index / 79))
    try { reader.current = createEqResponseReader(sampleRate, values) } catch { reader.current = undefined }
    return () => { reader.current = undefined }
  }, [sampleRate, highFrequency])
  useLayoutEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context || !reader.current) return
    const values = reader.current(settings, gainDb, filter)
    const width = canvas.width, height = canvas.height
    const yAt = (db: number) => (24 - Math.max(-84, Math.min(24, db))) / 108 * (height - 4) + 2
    context.clearRect(0, 0, width, height)
    context.strokeStyle = "#7d8b9e88"
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(0, yAt(0))
    context.lineTo(width, yAt(0))
    context.stroke()
    context.strokeStyle = id === "A" ? "#7ff2bb" : "#f4c478"
    context.beginPath()
    for (let i = 0; i < values.length; i++) {
      const x = i / (values.length - 1) * width
      const y = yAt(values[i])
      if (i === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.stroke()
  }, [settings.low, settings.mid, settings.high, gainDb, filter, sampleRate, id])

  return <div className="stacked-eq-overlay" role="img" aria-label={"Deck " + id + " channel response, frequency versus gain"}>
    <div><strong>Channel response</strong><span>0 dB line</span></div>
    <canvas ref={ref} width={296} height={56} aria-hidden="true" />
    <div><span>50 Hz</span><span>{(highFrequency / 1_000).toFixed(highFrequency % 1_000 ? 1 : 0)} kHz</span></div>
  </div>
}

type Gesture = {
  id: DeckId
  kind: "main" | "overview" | "preroll"
  track: AudioBuffer
  pointerId: number
  downX: number
  left: number
  width: number
  center: number
  span: number
  axisStart: number
  axisEnd: number
  from: number
  to: number
  moved: boolean
  scrubbing: boolean
  audioUpdatedAt: number
  audioPosition: number | null
}

type LoopSurface = "main" | "overview"
type LoopHandle = LoopEdge | "move"
type LoopTrim = {
  surface: LoopSurface
  target: LoopHandle
  track: AudioBuffer
  pointerId: number
  handle: HTMLDivElement
  downX: number
  width: number
  center: number
  span: number
  original: Loop
  range: Loop
}
const loopHandlesInOrder: LoopHandle[] = ["start", "move", "end"]
const noBeats: readonly number[] = []

function sameLoop(left: Loop | null | undefined, right: Loop) {
  return left?.start === right.start && left?.end === right.end
}

type DrawnFrame = {
  waveform: WaveformData
  beats: readonly TimelineBeat[] | undefined
  showBeats: boolean
  countedMeter: number | null
  center: number
  halfSpan: number
  mode: WaveformMode
}

function displayBeatGrid(times: readonly number[] = [], bpm: number | null | undefined, predicted: boolean | undefined,
  manual: ManualBeatGrid | null | undefined, duration: number | undefined) {
  if (manual && duration !== undefined) return manualBeatTicks(manual, duration, MIN_TRACK_SECONDS)
  const beats = estimateBeatGrid(times, bpm, predicted ? 0 : MIN_TRACK_SECONDS)
  return predicted ? beats.map(beat => ({ ...beat, estimated: true })) : beats
}

function drawMusicalTicks(canvas: HTMLCanvasElement, beats: readonly TimelineBeat[], origin: number, span: number,
  meter: number | null, showBeats: boolean) {
  const context = canvas.getContext("2d")
  if (!context || !beats.length) return
  const scale = context.getTransform().a
  const width = canvas.width / scale
  const height = canvas.height / scale
  const ticks = timelineGridTicks(beats, origin, origin + span, width, meter, showBeats)
  if (!ticks.length) return
  context.save()
  context.font = "9px ui-monospace, Consolas, monospace"
  context.textBaseline = "bottom"
  let lastLabel = -32
  for (const tick of ticks) {
    const x = (tick.time - origin) / span * width
    const accented = tick.bar !== null
    context.lineWidth = accented ? 1.4 : 1
    context.strokeStyle = tick.bar === null ? (tick.estimated ? "#d2e1f753" : "#d2e1f746")
      : tick.bar % 2 ? "#b8d9ffb0" : "#b8d9ff82"
    context.setLineDash(tick.estimated ? (accented ? [5, 3] : [2, 4]) : [])
    context.beginPath()
    context.moveTo(x, 34)
    context.lineTo(x, height - 12)
    context.stroke()
    if (x - lastLabel >= 30 && x < width - 20) {
      context.fillStyle = accented ? "#c3dfff" : "#aebed5"
      context.fillText(tick.bar === null ? String(tick.number) : "Bar " + tick.bar, x + 2, 32)
      lastLabel = x
    }
  }
  context.restore()
}

function drawRange(element: HTMLElement | null, range: Loop | null, origin: number, span: number) {
  if (!element) return
  if (!range || !(span > 0) || range.end <= origin || range.start >= origin + span || range.end <= range.start) {
    element.style.visibility = "hidden"
    return
  }
  element.style.visibility = "visible"
  const from = Math.max(0, (range.start - origin) / span * 100)
  element.style.left = from + "%"
  element.style.width = Math.max(0, Math.min(100, (range.end - origin) / span * 100) - from) + "%"
}

function drawLoopHandles(parent: HTMLElement | null, range: Loop | null, origin: number, span: number, trim: LoopTrim | null) {
  if (!parent || !range || !(span > 0)) return
  const visibleStart = Math.max(origin, range.start)
  const visibleEnd = Math.min(origin + span, range.end)
  for (const target of loopHandlesInOrder) {
    const handle = parent.querySelector<HTMLElement>(`[data-loop-edge="${target}"]`)
    if (!handle) continue
    const seconds = target === "move" ? (visibleStart + visibleEnd) / 2 : range[target]
    const percent = (seconds - origin) / span * 100
    const editing = trim?.handle === handle
    handle.style.setProperty("--loop-offset", percent + "%")
    const visible = target === "move" ? visibleEnd > visibleStart : (percent >= 0 && percent <= 100)
    handle.style.visibility = editing || visible ? "visible" : "hidden"
    handle.toggleAttribute("data-trimming", editing)
    if (editing) {
      handle.toggleAttribute("data-label-left", percent > 65)
      const text = handle.querySelector(".stacked-loop-edge-time")
      if (text) text.textContent = formatTime(target === "move" ? range.start : range[target], true)
    }
  }
}

function drawPendingLoop(parent: HTMLElement | null, start: number, end: number, origin: number, span: number) {
  if (!parent || !(span > 0)) return
  drawRange(parent.querySelector(".stacked-loop-pending-range"), end > start ? { start, end } : null, origin, span)
  const marker = parent.querySelector<HTMLElement>(".stacked-loop-pending-in")
  if (!marker) return
  const percent = (start - origin) / span * 100
  marker.style.visibility = percent >= 0 && percent <= 100 ? "visible" : "hidden"
  marker.style.left = percent + "%"
  marker.toggleAttribute("data-label-left", percent > 92)
}

function drawMarkers(parent: HTMLElement | null, origin: number, span: number) {
  if (!parent || !(span > 0)) return
  for (const item of parent.querySelectorAll<HTMLElement>("[data-cue-time]")) {
    const position = (Number(item.dataset.cueTime) - origin) / span * 100
    item.style.visibility = position >= 0 && position <= 100 ? "visible" : "hidden"
    item.style.left = position + "%"
  }
}

function overviewPrerollStart(cueTime: number, center: number) {
  const earliest = Math.min(cueTime, center)
  if (earliest >= 0) return 0
  return Math.max(MIN_TRACK_SECONDS, Math.floor((earliest - .25) / 4) * 4)
}

function cueColorStyle(cue: Cue, colors?: CueColors): CSSProperties | undefined {
  const color = displayCueColor(cue, colors)
  return color ? { "--cue-color": color } as CSSProperties : undefined
}

function HotCuePads({ id, track, cues, colors, selected, mode, triggerCue, pressCue }: {
  id: DeckId
  track: AudioBuffer
  cues: readonly Cue[]
  colors?: CueColors
  selected?: number | null
  mode: HotCueMode
  triggerCue?: (id: DeckId, index: number) => void
  pressCue?: PressCue
}) {
  const [gesture] = useState(createHotCueGesture<HTMLButtonElement>)
  useLayoutEffect(() => () => { gesture.cancel() }, [gesture, track, mode])
  useLayoutEffect(() => {
    const owner = gesture.owner()
    if (owner && !owner.isConnected) gesture.cancel(owner)
  }, [cues, gesture])
  useEffect(() => {
    const cancel = () => { gesture.cancel() }
    const cancelWhenHidden = () => { if (document.hidden) cancel() }
    window.addEventListener("blur", cancel)
    window.addEventListener("pagehide", cancel)
    document.addEventListener("visibilitychange", cancelWhenHidden)
    return () => {
      window.removeEventListener("blur", cancel)
      window.removeEventListener("pagehide", cancel)
      document.removeEventListener("visibilitychange", cancelWhenHidden)
    }
  }, [gesture])

  function begin(pad: HTMLButtonElement, index: number, input: HotCueInput) {
    if (mode === "instant") {
      triggerCue?.(id, index)
      return
    }
    gesture.begin(pad, input, () => {
      const releasePointer = () => {
        if (input.kind !== "pointer" || !pad.hasPointerCapture(input.id)) return
        try { pad.releasePointerCapture(input.id) } catch { /* The browser already ended this pointer. */ }
      }
      if (input.kind === "pointer") {
        try { pad.setPointerCapture(input.id) } catch { return }
      }
      const finish = pressCue?.(id, index, mode)
      if (!finish) { releasePointer(); return }
      pad.setAttribute("data-held", "")
      return reason => {
        pad.removeAttribute("data-held")
        releasePointer()
        finish(reason)
      }
    })
  }

  function activateVirtualCue(index: number) {
    gesture.cancel()
    if (mode === "release") pressCue?.(id, index, mode)?.("release")
    else triggerCue?.(id, index)
  }

  if (!cues.length) return <p className="stacked-hot-cues-empty">Add hot cues in Cue points.</p>
  return <ul className="stacked-hot-cues" aria-label={"Deck " + id + " hot cues"}>
    {cues.map((cue, index) => {
      const loop = getLoop(cue, track.duration)
      const leadIn = Boolean(cue.metadata?.lead_in)
      const start = formatTime(cue.time_seconds, true)
      const end = loop ? formatTime(loop.end_seconds, true) : null
      const caption = loop ? "Loop · " + formatTime(cue.time_seconds) : leadIn ? "Lead-in · " + formatTime(cue.time_seconds) : start
      const timing = end ? start + " to " + end : start
      const audibleLabel = loop ? "loop, " + timing : leadIn ? "lead-in, " + timing : timing
      return <li key={cueIdentity(cue) ?? `${index}:${cue.time_seconds}:${cue.label}`}>
        <button type="button" className="stacked-hot-cue" data-lead={leadIn} data-loop={Boolean(loop)}
          aria-current={selected === index ? "true" : undefined}
          aria-label={"Trigger Deck " + id + " hot cue " + (index + 1) + ": " + cue.label + ", " + audibleLabel}
          title={cue.label + " · " + timing} style={cueColorStyle(cue, colors)}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault()
            if (event.pointerType !== "touch") event.currentTarget.focus({ preventScroll: true })
            begin(event.currentTarget, index, { kind: "pointer", id: event.pointerId })
          }}
          onPointerUp={event => {
            const pad = event.currentTarget
            if (gesture.owner() !== pad) return
            const { left, right, top, bottom } = pad.getBoundingClientRect()
            const inside = event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom
            gesture.finish(pad, { kind: "pointer", id: event.pointerId }, inside ? "release" : "cancel")
          }}
          onPointerCancel={event => gesture.finish(event.currentTarget, { kind: "pointer", id: event.pointerId }, "cancel")}
          onLostPointerCapture={event => gesture.finish(event.currentTarget, { kind: "pointer", id: event.pointerId }, "cancel")}
          onBlur={event => gesture.cancel(event.currentTarget)}
          onKeyDown={event => {
            const { key } = event
            if (key === "Escape" && gesture.cancel(event.currentTarget)) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            if ((key !== " " && key !== "Enter") || event.altKey || event.ctrlKey || event.metaKey) return
            event.preventDefault()
            event.stopPropagation()
            if (!event.repeat) begin(event.currentTarget, index, { kind: "keyboard", key })
          }}
          onKeyUp={event => {
            const { key } = event
            if (key !== " " && key !== "Enter") return
            event.preventDefault()
            event.stopPropagation()
            gesture.finish(event.currentTarget, { kind: "keyboard", key }, "release")
          }}
          onClick={event => {
            const native = event.nativeEvent
            if (event.detail === 0 && !("pointerType" in native && native.pointerType)) activateVirtualCue(index)
          }}>
          <span className="stacked-hot-cue-number" aria-hidden="true">{index + 1}</span>
          <span className="stacked-hot-cue-copy" aria-hidden="true">
            <strong>{cue.label}</strong>
            <span>{caption}</span>
          </span>
        </button>
      </li>
    })}
  </ul>
}

export default function TransitionWaveforms({
  tracks, names, positions, speeds, isPlaying, getPositions, seek, beginScrub, updateScrub, endScrub,
  cues, cueColors, beatTimes, predictedBeatGrid, manualBeatGrid, bpm, loops, selectedCues,
  selectCue, triggerCue, hotCueMode = "instant", pressCue, createLoop, trimLoop, loopBeatTimes, loopQuantize = "off",
  pendingLoopIns, loopEditor, eq, gainDb, filter, toolbar, onWaveformReady,
}: TransitionWaveformsProps) {
  const [preferences, setPreferences] = useState(readPreferences)
  const { mode, span, eqOverlay, gridLayers, meter } = preferences
  const [width, setWidth] = useState(640)
  const canvas = useRef<Partial<Record<DeckId, HTMLCanvasElement>>>({})
  const overviewCanvas = useRef<Partial<Record<DeckId, HTMLCanvasElement>>>({})
  const lanes = useRef<Partial<Record<DeckId, HTMLDivElement>>>({})
  const overviews = useRef<Partial<Record<DeckId, HTMLDivElement>>>({})
  const prerollStarts = useRef<Partial<DeskClock>>({})
  const surface = useRef<HTMLDivElement>(null)
  const lastDraw = useRef<Partial<Record<DeckId, DrawnFrame>>>({})
  const lastOverviewDraw = useRef<Partial<Record<DeckId, { waveform: WaveformData; mode: WaveformMode }>>>({})
  const reportedWaveforms = useRef<Partial<Record<DeckId, WaveformData>>>({})
  const gesture = useRef<Gesture | null>(null)
  const loopTrims = useRef<Partial<Record<DeckId, LoopTrim>>>({})
  const wheel = useRef<{ id: DeckId; seconds: number; track: AudioBuffer } | null>(null)
  const wheelTimer = useRef<number | undefined>(undefined)
  const sameTrack = tracks.A === tracks.B
  const a = useWaveform(tracks.A)
  const other = useWaveform(sameTrack ? undefined : tracks.B)
  const b = sameTrack ? a : other
  const waveforms = { A: a, B: b }
  const aBeats = useMemo(() => displayBeatGrid(beatTimes?.A, bpm?.A, predictedBeatGrid?.A, manualBeatGrid?.A, tracks.A?.duration),
    [beatTimes?.A, bpm?.A, predictedBeatGrid?.A, manualBeatGrid?.A, tracks.A?.duration])
  const bBeats = useMemo(() => displayBeatGrid(beatTimes?.B, bpm?.B, predictedBeatGrid?.B, manualBeatGrid?.B, tracks.B?.duration),
    [beatTimes?.B, bpm?.B, predictedBeatGrid?.B, manualBeatGrid?.B, tracks.B?.duration])
  const displayBeats = { A: aBeats, B: bBeats }
  const firstCue = (id: DeckId) => cues?.[id]?.reduce((first, cue) => Math.min(first, cue.time_seconds), 0) ?? 0
  const prerollCues = { A: firstCue("A"), B: firstCue("B") }
  const latest = useRef({ waveforms, tracks, speeds, span, mode, gridLayers, meter, isPlaying, getPositions,
    positions, displayBeats, loops, seek, endScrub, prerollCues, trimLoop, loopBeatTimes, loopQuantize, pendingLoopIns })
  latest.current = { waveforms, tracks, speeds, span, mode, gridLayers, meter, isPlaying, getPositions,
    positions, displayBeats, loops, seek, endScrub, prerollCues, trimLoop, loopBeatTimes, loopQuantize, pendingLoopIns }

  useEffect(() => {
    try { localStorage.setItem(prefsKey, JSON.stringify(preferences)) } catch { /* Local storage is optional. */ }
  }, [preferences])
  useEffect(() => {
    for (const id of decks) {
      const waveform = id === "A" ? a : b
      const buffer = tracks[id]
      if (!buffer || !waveform) delete reportedWaveforms.current[id]
      else if (onWaveformReady && reportedWaveforms.current[id] !== waveform) {
        reportedWaveforms.current[id] = waveform
        onWaveformReady(id, buffer, waveform)
      }
    }
  }, [a, b, tracks.A, tracks.B, onWaveformReady])

  const paint = useCallback((force = false) => {
    const current = latest.current
    const clock = current.isPlaying ? current.getPositions() : current.positions
    for (const id of decks) {
      const waveform = current.waveforms[id]
      const track = current.tracks[id]
      const lane = lanes.current[id] ?? null
      const overview = overviews.current[id] ?? null
      if (!track) {
        delete lastDraw.current[id]
        delete lastOverviewDraw.current[id]
        delete prerollStarts.current[id]
        continue
      }
      const drag = gesture.current?.id === id && gesture.current.track === track ? gesture.current : null
      const deckTrim = loopTrims.current[id]
      const trim = deckTrim?.track === track ? deckTrim : null
      const nudge = wheel.current?.id === id && wheel.current.track === track ? wheel.current : null
      const preview = drag?.kind === "main" && drag.moved ? drag.to : nudge?.seconds
      // Freeze the grabbed lane's ruler while audio and the overview clock keep running.
      const center = trim?.surface === "main" ? trim.center : clampPosition(preview ?? clock[id], track.duration)
      const halfSpan = (trim?.surface === "main" ? trim.span : current.span * playbackRate(current.speeds[id])) / 2
      const origin = center - halfSpan
      const drawing = canvas.current[id]
      const last = lastDraw.current[id]
      const showBeats = current.gridLayers.beats
      const countedMeter = current.gridLayers.bars ? current.meter : null
      const beats = showBeats || countedMeter !== null ? current.displayBeats[id] : undefined
      if (waveform && drawing && (force || last?.waveform !== waveform || last.center !== center
        || last.halfSpan !== halfSpan || last.mode !== current.mode || last.beats !== beats
        || last.showBeats !== showBeats || last.countedMeter !== countedMeter)) {
        drawWaveform(drawing, waveform, origin, center + halfSpan, current.mode, false)
        if (beats) drawMusicalTicks(drawing, beats, origin, halfSpan * 2, countedMeter, showBeats)
        lastDraw.current[id] = { waveform, beats, center, halfSpan, mode: current.mode, showBeats, countedMeter }
      }
      const previousPreroll = prerollStarts.current[id] ?? 0
      const prerollStart = drag && drag.kind !== "main" ? previousPreroll
        : overviewPrerollStart(current.prerollCues[id], center)
      prerollStarts.current[id] = prerollStart
      const preroll = overview?.querySelector<HTMLElement>(".stacked-overview-preroll") ?? null
      const audioRegion = overview?.querySelector<HTMLElement>(".stacked-overview-audio") ?? null
      if (preroll) preroll.hidden = prerollStart === 0
      const overviewResized = (previousPreroll === 0) !== (prerollStart === 0)
      const mini = overviewCanvas.current[id]
      const lastMini = lastOverviewDraw.current[id]
      if (waveform && mini && (force || overviewResized || lastMini?.waveform !== waveform || lastMini.mode !== current.mode)) {
        drawWaveform(mini, waveform, 0, waveform.duration, current.mode)
        lastOverviewDraw.current[id] = { waveform, mode: current.mode }
      }
      drawMarkers(lane, origin, halfSpan * 2)
      drawMarkers(audioRegion, 0, track.duration)
      if (prerollStart < 0) drawMarkers(preroll, prerollStart, -prerollStart)
      const loop = current.loops?.[id] ?? null
      drawRange(lane?.querySelector<HTMLElement>(".stacked-loop-region") ?? null, loop, origin, halfSpan * 2)
      drawRange(lane?.querySelector<HTMLElement>(".stacked-loop-draft") ?? null, trim?.range ?? null, origin, halfSpan * 2)
      drawRange(audioRegion?.querySelector<HTMLElement>(".stacked-loop-region") ?? null, loop, 0, track.duration)
      drawLoopHandles(lane, trim?.range ?? loop, origin, halfSpan * 2, trim)
      drawLoopHandles(audioRegion, trim?.range ?? loop, 0, track.duration, trim)
      drawRange(audioRegion?.querySelector<HTMLElement>(".stacked-overview-window") ?? null,
        { start: origin, end: center + halfSpan }, 0, track.duration)
      if (prerollStart < 0) drawRange(preroll?.querySelector<HTMLElement>(".stacked-overview-window") ?? null,
        { start: origin, end: center + halfSpan }, prerollStart, -prerollStart)
      const selection = drag?.kind === "overview" && drag.moved
        ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) } : null
      drawRange(audioRegion?.querySelector<HTMLElement>(".stacked-loop-draft") ?? null, trim?.range ?? selection, 0, track.duration)
      const pendingIn = current.pendingLoopIns?.[id]
      if (pendingIn != null) {
        const pendingOut = clampPosition(preview ?? clock[id], track.duration, 0)
        drawPendingLoop(lane, pendingIn, pendingOut, origin, halfSpan * 2)
        drawPendingLoop(audioRegion, pendingIn, pendingOut, 0, track.duration)
      }
      const playhead = audioRegion?.querySelector<HTMLElement>(".stacked-overview-playhead")
      const negativePlayhead = preroll?.querySelector<HTMLElement>(".stacked-overview-playhead")
      const playheadTime = trim?.surface === "main" ? clampPosition(clock[id], track.duration) : center
      if (playhead) {
        playhead.hidden = playheadTime < 0
        playhead.style.left = playheadTime / track.duration * 100 + "%"
      }
      if (negativePlayhead && prerollStart < 0) {
        negativePlayhead.hidden = playheadTime >= 0
        negativePlayhead.style.left = (playheadTime - prerollStart) / -prerollStart * 100 + "%"
      }
      const label = lane?.querySelector<HTMLElement>(".stacked-scrub-time")
      if (label) {
        label.style.visibility = preview === undefined ? "hidden" : "visible"
        if (preview !== undefined) label.textContent = formatTime(center, true)
      }
    }
  }, [])

  const clearLoopTrim = useCallback((id: DeckId, repaint = true) => {
    const current = loopTrims.current[id]
    delete loopTrims.current[id]
    if (!current) return
    if (current.handle.hasPointerCapture(current.pointerId)) {
      try { current.handle.releasePointerCapture(current.pointerId) } catch { /* The browser already released it. */ }
    }
    if (repaint) paint()
  }, [paint])

  useLayoutEffect(() => {
    for (const id of decks) {
      const active = loopTrims.current[id]
      if (active && (!trimLoop || !active.handle.isConnected || tracks[id] !== active.track
        || !sameLoop(loops?.[id], active.original))) clearLoopTrim(id)
    }
  })
  useEffect(() => {
    const cancel = () => { for (const id of decks) clearLoopTrim(id) }
    const cancelWhenHidden = () => { if (document.hidden) cancel() }
    window.addEventListener("blur", cancel)
    window.addEventListener("pagehide", cancel)
    document.addEventListener("visibilitychange", cancelWhenHidden)
    return () => {
      window.removeEventListener("blur", cancel)
      window.removeEventListener("pagehide", cancel)
      document.removeEventListener("visibilitychange", cancelWhenHidden)
      for (const id of decks) clearLoopTrim(id, false)
    }
  }, [clearLoopTrim])

  // Playback already has a frame loop. A paused deck still needs marker updates.
  useLayoutEffect(() => { if (!isPlaying) paint() })
  useEffect(() => {
    const frameElement = surface.current
    if (!frameElement) return
    const resize = () => {
      for (const id of decks) {
        const active = loopTrims.current[id]
        if (active && Math.abs((active.handle.parentElement?.getBoundingClientRect().width ?? 0) - active.width) > 1) {
          clearLoopTrim(id, false)
        }
      }
      setWidth(frameElement.getBoundingClientRect().width)
      paint(true)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(frameElement)
    for (const element of Object.values(overviews.current)) if (element) observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [paint, clearLoopTrim, Boolean(tracks.A), Boolean(tracks.B)])
  useEffect(() => {
    if (!isPlaying || !(tracks.A || tracks.B)) return
    let frame = 0
    const animate = () => {
      paint()
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [isPlaying, tracks.A, tracks.B, paint])

  useEffect(() => {
    const active = gesture.current
    if (!active || active.track === latest.current.tracks[active.id]) return
    gesture.current = null
    if (active.scrubbing) latest.current.endScrub?.(active.id)
  }, [tracks.A, tracks.B])

  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active?.scrubbing) latest.current.endScrub?.(active.id)
  }, [])

  function clearWheel() {
    window.clearTimeout(wheelTimer.current)
    wheel.current = null
  }
  useEffect(() => {
    const element = surface.current
    if (!element) return
    const nudge = (event: WheelEvent) => {
      // Intentionally preserve ordinary vertical scroll over the waveforms.
      if (gesture.current || event.ctrlKey || event.metaKey || event.altKey) return
      const delta = event.shiftKey
        ? (Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY)
        : (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0)
      if (!delta || !(event.target instanceof Element)) return
      const id = event.target.closest<HTMLElement>("[data-wave-scrub]")?.dataset.waveScrub
      if ((id !== "A" && id !== "B") || loopTrims.current[id]) return
      const current = latest.current
      const track = current.tracks[id]
      if (!track || !current.seek) return
      event.preventDefault()
      const base = wheel.current?.id === id && wheel.current.track === track
        ? wheel.current.seconds : current.getPositions()[id]
      clearWheel()
      wheel.current = { id, track, seconds: clampPosition(base + Math.sign(delta) * .01, lastPlayableTime(track)) }
      paint()
      wheelTimer.current = window.setTimeout(() => {
        const pending = wheel.current
        clearWheel()
        if (pending && latest.current.tracks[pending.id] === pending.track) latest.current.seek?.(pending.id, pending.seconds)
        paint()
      }, 75)
    }
    element.addEventListener("wheel", nudge, { passive: false })
    return () => { element.removeEventListener("wheel", nudge); clearWheel() }
  }, [paint])

  function updateGesture(current: Gesture, clientX: number) {
    current.moved ||= Math.abs(clientX - current.downX) >= 4
    if (current.kind !== "main") {
      const time = current.axisStart + (clientX - current.left) / current.width * (current.axisEnd - current.axisStart)
      current.to = clampPosition(time, current.axisEnd, current.axisStart)
    } else {
      // Grabbing the waveform pulls source time past the static playhead.
      current.to = clampPosition(current.center - (clientX - current.downX) / current.width * current.span,
        lastPlayableTime(current.track))
    }
  }

  function beginGesture(event: PointerEvent<HTMLDivElement>, id: DeckId, kind: Gesture["kind"]) {
    const track = tracks[id]
    if (!event.isPrimary || event.button !== 0 || gesture.current || loopTrims.current[id] || !track
      || (!seek && !(kind === "overview" && createLoop))) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    clearWheel()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    const center = getPositions()[id]
    const axisStart = kind === "preroll" ? prerollStarts.current[id] ?? 0 : 0
    const axisEnd = kind === "preroll" ? 0 : track.duration
    const time = axisStart + (event.clientX - rect.left) / rect.width * (axisEnd - axisStart)
    const from = kind === "main" ? center : clampPosition(time, axisEnd, axisStart)
    gesture.current = {
      id, kind, pointerId: event.pointerId, track, downX: event.clientX, left: rect.left, width: rect.width,
      center, span: span * playbackRate(speeds[id]), axisStart, axisEnd, from, to: from, moved: false,
      scrubbing: false, audioUpdatedAt: -Infinity, audioPosition: null,
    }
  }

  function auditionDrag(current: Gesture, now: number) {
    if (current.kind !== "main" || !current.moved || tracks[current.id] !== current.track) return
    const first = current.audioUpdatedAt === -Infinity
    if (first) {
      current.scrubbing = Boolean(updateScrub && endScrub && beginScrub?.(current.id, current.to))
    } else if (current.scrubbing && now - current.audioUpdatedAt >= 45
      && Math.abs(current.to - (current.audioPosition ?? current.to)) >= .008) {
      updateScrub?.(current.id, current.to)
    } else return
    current.audioPosition = current.to
    current.audioUpdatedAt = now
  }

  function cancelGesture() {
    const current = gesture.current
    gesture.current = null
    if (current?.scrubbing) endScrub?.(current.id)
    paint()
  }

  function cancelPointer(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === event.pointerId) cancelGesture()
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    updateGesture(current, event.clientX)
    if (tracks[current.id] !== current.track) { cancelGesture(); return }
    gesture.current = null
    if (current.scrubbing) {
      endScrub?.(current.id, current.to)
      paint()
      return
    }
    if (current.kind === "overview" && current.moved && createLoop && Math.abs(current.to - current.from) >= .05) {
      createLoop(current.id, Math.min(current.from, current.to), Math.max(current.from, current.to))
      return
    }
    const time = current.kind !== "main"
      ? current.to
      : current.moved ? current.to : current.center + ((event.clientX - current.left) / current.width - .5) * current.span
    seek?.(current.id, clampPosition(time, lastPlayableTime(current.track)))
  }

  function startLoopTrim(event: PointerEvent<HTMLDivElement>, id: DeckId, surface: LoopSurface, target: LoopHandle,
    track: AudioBuffer, range: Loop) {
    if (event.button !== 0 || loopTrims.current[id] || gesture.current?.id === id) return
    const handle = event.currentTarget
    const width = handle.parentElement?.getBoundingClientRect().width ?? 0
    if (!(width > 0)) return
    event.preventDefault()
    event.stopPropagation()
    if (wheel.current?.id === id) clearWheel()
    if (event.pointerType !== "touch") handle.focus({ preventScroll: true })
    try { handle.setPointerCapture(event.pointerId) } catch { return }
    const drawn = lastDraw.current[id]
    const frame = drawn?.waveform === waveforms[id] ? drawn : undefined
    const center = frame?.center ?? clampPosition(getPositions()[id], track.duration)
    const viewSpan = frame ? frame.halfSpan * 2 : span * playbackRate(speeds[id])
    loopTrims.current[id] = {
      surface, target, track, handle, width, downX: event.clientX, pointerId: event.pointerId, center,
      span: surface === "main" ? viewSpan : track.duration, original: range, range,
    }
    paint()
  }

  function updateLoopTrim(event: PointerEvent<HTMLDivElement>, id: DeckId, commit: boolean) {
    const current = loopTrims.current[id]
    if (!current || current.handle !== event.currentTarget || current.pointerId !== event.pointerId) return
    event.stopPropagation()
    const props = latest.current
    if (props.tracks[id] !== current.track || !sameLoop(props.loops?.[id], current.original)) {
      clearLoopTrim(id)
      return
    }
    const delta = (event.clientX - current.downX) / current.width * current.span
    const { original, target, track } = current
    const mode = event.shiftKey ? "off" : props.loopQuantize
    const beats = props.loopBeatTimes?.[id] ?? noBeats
    const range = delta === 0 ? original : target === "move"
      ? movePerformanceLoop(original, original.start + delta, track.duration, beats, mode)
      : clampPerformanceLoopEdge(original, target, original[target] + delta, track.duration, beats, mode)
    if (range) current.range = range
    if (commit) {
      clearLoopTrim(id, false)
      if (!sameLoop(current.range, original)) props.trimLoop?.(id, current.range)
    }
    paint()
  }

  function loopHandles(id: DeckId, surface: LoopSurface) {
    const track = tracks[id]
    const range = loops?.[id]
    if (!track || !range || !trimLoop) return null
    return loopHandlesInOrder.map(target => {
      const [min, max] = target === "move" ? [0, track.duration - (range.end - range.start)]
        : performanceLoopEdgeLimits(range, target, track.duration)
      const name = target === "start" ? "In" : target === "end" ? "Out" : "Move"
      const seconds = target === "move" ? range.start : range[target]
      const operation = target === "move" ? "Drag to move the loop without changing its length." : `Drag ${name} to trim the loop.`
      function cancelPointer(event: PointerEvent<HTMLDivElement>) {
        const active = loopTrims.current[id]
        if (active?.handle === event.currentTarget && active.pointerId === event.pointerId) {
          event.stopPropagation()
          clearLoopTrim(id)
        }
      }
      return <div key={target} className="stacked-loop-edge" data-loop-edge={target} role="slider" tabIndex={0}
        aria-label={`Deck ${id} loop ${name} (${surface === "main" ? "waveform" : "overview"})`}
        aria-valuemin={min} aria-valuemax={max} aria-valuenow={seconds} aria-valuetext={formatTime(seconds, true)}
        title={operation + " Shift-drag ignores Quantize. Arrow keys move by 10 ms, or 1 ms with Shift."}
        onPointerDown={event => startLoopTrim(event, id, surface, target, track, range)}
        onPointerMove={event => updateLoopTrim(event, id, false)} onPointerUp={event => updateLoopTrim(event, id, true)}
        onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}
        onBlur={event => { if (loopTrims.current[id]?.handle === event.currentTarget) clearLoopTrim(id) }}
        onKeyDown={event => {
          if (event.key === "Escape" && loopTrims.current[id]?.handle === event.currentTarget) {
            event.stopPropagation()
            clearLoopTrim(id)
            return
          }
          if (loopTrims.current[id] || event.altKey || event.ctrlKey || event.metaKey) return
          const step = event.shiftKey ? .001 : .01
          let next: number
          switch (event.key) {
            case "ArrowLeft": case "ArrowDown": next = seconds - step; break
            case "ArrowRight": case "ArrowUp": next = seconds + step; break
            case "Home": next = min; break
            case "End": next = max; break
            default: return
          }
          event.preventDefault()
          event.stopPropagation()
          const result = target === "move" ? movePerformanceLoop(range, next, track.duration)
            : clampPerformanceLoopEdge(range, target, next, track.duration)
          if (result && !sameLoop(result, range)) trimLoop(id, result)
        }}>
        <span aria-hidden="true">{name}</span>
        <span aria-hidden="true" className="stacked-loop-edge-time time" />
      </div>
    })
  }

  function pendingLoopOverlay(id: DeckId) {
    return pendingLoopIns?.[id] != null && <>
      <div className="stacked-loop-pending-range" aria-hidden="true" />
      <div className="stacked-loop-pending-in" aria-hidden="true"><span>In</span></div>
    </>
  }

  function hitArea(id: DeckId, kind: Gesture["kind"]) {
    const track = tracks[id]
    const canSeek = !!(track && seek)
    const canLoop = kind === "overview" && Boolean(track && createLoop)
    const prefix = "Deck " + id + (kind === "overview" ? " overview" : kind === "preroll" ? " pre-roll" : " waveform")
    const min = kind === "overview" ? 0 : MIN_TRACK_SECONDS
    const max = kind === "preroll" ? 0 : track?.duration ?? 0
    const position = clampPosition(positions[id], max, min)
    return <div className="stacked-waveform-hit" role={canSeek ? "slider" : undefined}
      data-wave-scrub={kind === "main" ? id : undefined} data-seekable={canSeek || canLoop}
      aria-label={canSeek ? prefix + " position" : undefined}
      tabIndex={canSeek || canLoop ? 0 : undefined} aria-valuemin={canSeek ? min : undefined}
      aria-valuemax={canSeek ? max : undefined}
      aria-valuenow={canSeek ? position : undefined}
      aria-valuetext={canSeek ? formatTime(position, true) : undefined}
      onPointerDown={event => beginGesture(event, id, kind)}
      onPointerMove={event => {
        const current = gesture.current
        if (!current || current.pointerId !== event.pointerId) return
        updateGesture(current, event.clientX)
        auditionDrag(current, performance.now())
        paint()
      }}
      onPointerUp={finishGesture} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && gesture.current) { cancelGesture(); return }
        if (!track || !canSeek) return
        const base = clampPosition(getPositions()[id], max, min)
        const increment = event.shiftKey ? .001 : kind === "overview" ? 1 : .01
        let next: number
        switch (event.key) {
          case "ArrowLeft": case "ArrowDown": next = base - increment; break
          case "ArrowRight": case "ArrowUp": next = base + increment; break
          case "Home": next = kind === "preroll" ? prerollStarts.current[id] ?? 0 : 0; break
          case "End": next = max; break
          default: return
        }
        event.preventDefault()
        seek?.(id, clampPosition(next, Math.min(max, lastPlayableTime(track)), min))
      }} />
  }

  function cueMarkers(id: DeckId, kind: Gesture["kind"]) {
    const track = tracks[id]
    if (!track) return null
    return cues?.[id]?.map((cue, index) => {
      if ((kind === "overview" && cue.time_seconds < 0) || (kind === "preroll" && cue.time_seconds >= 0)) return null
      const leadIn = Boolean(cue.metadata?.lead_in)
      const kindLabel = leadIn ? "lead-in" : "cue"
      const markerTitle = cue.label + " · " + formatTime(cue.time_seconds, true)
      return <button type="button" key={cueIdentity(cue) ?? index} className="stacked-cue-marker"
        data-lead={leadIn} data-cue-time={cue.time_seconds} data-cue-selected={selectedCues?.[id] === index}
        title={markerTitle} style={cueColorStyle(cue, cueColors)}
        aria-label={"Deck " + id + " " + kindLabel + " " + (index + 1) + ": " + cue.label
          + (kind === "overview" ? " (overview)" : kind === "preroll" ? " (pre-roll)" : "")}
        onClick={() => {
          if (selectCue) selectCue(id, index)
          else seek?.(id, clampPosition(cue.time_seconds, lastPlayableTime(track)))
        }}>
        <span>{kind === "main" ? (index + 1) + " " + cue.label : index + 1}</span>
      </button>
    })
  }

  const step = timelineStep(span, width)
  const intervalCount = Math.floor(span / 2 / step)
  const ticks = gridLayers.seconds ? Array.from({ length: 2 * intervalCount + 1 }, (_, index) => (index - intervalCount) * step) : []
  const showMusicalGrid = gridLayers.beats || gridLayers.bars
  const screenPercent = (offset: number) => 50 + (offset / span) * 100

  return (
    <section className="panel stacked-waveforms" aria-label="Stacked waveforms">
      <div className="stacked-waveform-header">
        <div className="panel-toolbar">
          <h2>Waveforms</h2>
          {toolbar}
          <div className="wave-tools">
            <div className="segments wave-mode" role="group" aria-label="Waveform view">
              {viewModes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id}
                onClick={() => setPreferences(previous => ({ ...previous, mode: item.id }))}>{item.label}</button>)}
            </div>
            <details className="waveform-timeline" onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
            }} onKeyDown={event => {
              if (event.key === "Escape" && event.currentTarget.open) {
                event.stopPropagation()
                event.currentTarget.open = false
                event.currentTarget.querySelector("summary")?.focus()
              }
            }}>
              <summary className="quiet stacked-toggle" aria-label="Waveform grid">
                Grid <CaretDownIcon aria-hidden="true" />
              </summary>
              <div className="waveform-timeline-menu">
                <fieldset aria-label="Grid layers">
                  {gridModes.map(unit => <label key={unit}>
                    <input type="checkbox" checked={gridLayers[unit]} onChange={event => {
                      const checked = event.target.checked
                      setPreferences(previous => ({ ...previous, gridLayers: { ...previous.gridLayers, [unit]: checked } }))
                    }} /> {grids[unit]}
                  </label>)}
                </fieldset>
                {gridLayers.bars && <>
                  <label className="waveform-meter">Beats per bar
                    <select value={meter} onChange={event => {
                      const next = Number(event.target.value)
                      setPreferences(previous => ({ ...previous, meter: next }))
                    }}>
                      {meters.map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>
                  <p>Counted from the first analyzed beat on each deck.</p>
                </>}
              </div>
            </details>
            <button type="button" className="quiet stacked-toggle" aria-pressed={eqOverlay}
              aria-label="Channel response overlay" title="Show channel EQ, trim and filter response"
              onClick={() => setPreferences(previous => ({ ...previous, eqOverlay: !previous.eqOverlay }))}>Response</button>
            <div className="segments zoom-controls" role="group" aria-label="Waveform zoom">
              <button type="button" aria-label="Zoom out" disabled={span >= 32}
                onClick={() => setPreferences(previous => ({ ...previous, span: Math.min(32, previous.span * 2) as Span }))}><MinusIcon aria-hidden="true" /></button>
              <span aria-label={span + "-second visible window"}>{span} s</span>
              <button type="button" aria-label="Zoom in" disabled={span <= 2}
                onClick={() => setPreferences(previous => ({ ...previous, span: Math.max(2, previous.span / 2) as Span }))}><PlusIcon aria-hidden="true" /></button>
            </div>
          </div>
        </div>
        {loopEditor}
        <div className="stacked-ruler" aria-hidden="true">
          {!gridLayers.seconds && showMusicalGrid && <span className="stacked-ruler-mode">
            {gridLayers.bars ? "Counted bars · " + meter + " beats per bar" : "Beat grid"}
          </span>}
          {ticks.map(offset => {
            const left = screenPercent(offset)
            const style = left < 4 ? " ruler-start" : left > 96 ? " ruler-end" : ""
            return <span key={offset} className={"time" + style} style={{ left: left + "%" }}>
              {offset === 0 ? "0 s" : (offset < 0 ? "−" : "+") + Number(Math.abs(offset).toFixed(2)) + " s"}
            </span>
          })}
        </div>
      </div>
      <div className="stacked-waveform-surface" ref={surface}>
        {decks.map(id => {
          const waveform = waveforms[id]
          const track = tracks[id]
          const settings = eq?.[id]
          return (
            <div key={id} className="stacked-waveform-lane" data-deck={id}
              ref={element => { if (element) lanes.current[id] = element; else delete lanes.current[id] }}>
              <div className="stacked-waveform-label">
                <span aria-hidden="true">Deck {id}</span>
                {names?.[id] && <strong aria-hidden="true" title={names[id]}>{names[id]}</strong>}
                {showMusicalGrid && predictedBeatGrid?.[id] && <small className="stacked-model-grid">Beat This estimate</small>}
                {showMusicalGrid && manualBeatGrid?.[id] && <small className="stacked-model-grid">Manual grid</small>}
              </div>
              {showMusicalGrid && track && !beatTimes?.[id]?.length && <small className="stacked-no-beats">
                {bpm?.[id] ? "Tempo available · Beat positions unverified" : "No analyzed beats"}
              </small>}
              {waveform
                ? <canvas ref={element => { if (element) canvas.current[id] = element; else delete canvas.current[id] }} aria-hidden="true" />
                : <p>{track ? waveform === null ? "Waveform unavailable" : "Drawing waveform…" : "Open audio on Deck " + id + " to see its waveform."}</p>}
              <div className="stacked-loop-region" aria-hidden="true" />
              <div className="stacked-loop-draft" aria-hidden="true" />
              {pendingLoopOverlay(id)}
              {hitArea(id, "main")}
              {cueMarkers(id, "main")}
              {loopHandles(id, "main")}
              <span className="stacked-scrub-time time" aria-hidden="true" />
              {eqOverlay && track && settings && <ChannelOverlay settings={settings} gainDb={gainDb?.[id] ?? 0}
                filter={filter?.[id] ?? 0} sampleRate={track.sampleRate} id={id} />}
            </div>
          )
        })}
        {ticks.filter(offset => offset !== 0).map(offset => (
          <i aria-hidden="true" className="stacked-time-line" key={offset} style={{ left: screenPercent(offset) + "%" }} />
        ))}
        {(tracks.A || tracks.B) && <div className="playhead stacked-playhead" aria-hidden="true" />}
      </div>
      {(tracks.A || tracks.B) && <div className="stacked-overviews" role="group" aria-label="Full-track overviews">
        {decks.map(id => {
          const track = tracks[id]
          if (!track) return null
          return <section key={id} className="stacked-overview-deck" data-deck={id} aria-label={"Deck " + id + " overview"}>
            <div className="stacked-overview" data-deck={id}
              ref={element => { if (element) overviews.current[id] = element; else delete overviews.current[id] }}>
              <div className="stacked-overview-preroll" hidden>
                <span className="stacked-overview-label" aria-hidden="true">Pre-roll</span>
                <div className="stacked-overview-window" aria-hidden="true" />
                <div className="stacked-overview-playhead" aria-hidden="true" />
                {hitArea(id, "preroll")}
                {cueMarkers(id, "preroll")}
              </div>
              <div className="stacked-overview-audio">
                <canvas ref={element => { if (element) overviewCanvas.current[id] = element; else delete overviewCanvas.current[id] }} aria-hidden="true" />
                <span className="stacked-overview-label" aria-hidden="true">{id}</span>
                <div className="stacked-overview-window" aria-hidden="true" />
                <div className="stacked-loop-region" aria-hidden="true" />
                <div className="stacked-loop-draft" aria-hidden="true" />
                {pendingLoopOverlay(id)}
                <div className="stacked-overview-playhead" aria-hidden="true" />
                {hitArea(id, "overview")}
                {cueMarkers(id, "overview")}
                {loopHandles(id, "overview")}
              </div>
            </div>
            {triggerCue && <HotCuePads id={id} track={track} cues={cues?.[id] ?? noCues} colors={cueColors} selected={selectedCues?.[id]}
              mode={pressCue ? hotCueMode : "instant"} triggerCue={triggerCue} pressCue={pressCue} />}
          </section>
        })}
        <p className="stacked-waveform-help">Drag waveform to scrub audio · Shift-wheel to nudge · Drag overview to set a loop
          {trimLoop && Boolean(loops?.A || loops?.B || loopEditor) && " · Drag In/Out to trim · Drag Move to slide"}
          {showMusicalGrid && <span className="estimated-grid-key">Dashed grid lines are estimates</span>}
        </p>
      </div>}
    </section>
  )
}
