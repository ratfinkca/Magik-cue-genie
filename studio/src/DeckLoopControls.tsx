import { useCallback, useEffect, useState } from "react"
import { formatTime } from "./cues"
import { captureLoopEdge, LOOP_FACTORS, makeBeatLoop, normalizePerformanceLoop, resizePerformanceLoop } from "./performanceLoop"
import type { LoopEdge, LoopFactor } from "./performanceLoop"
import type { QuantizeMode } from "./quantize"
import type { DeckId, DeckLoop, TransitionTrack, useTransitionAudio } from "./transitionAudio"
import "./deckLoopControls.css"

type TransitionAudio = ReturnType<typeof useTransitionAudio>
const loopLabels: Record<LoopFactor, { beats: string; button: string }> = {
  .125: { beats: "eighth", button: "⅛" },
  .25: { beats: "quarter", button: "¼" },
  .5: { beats: "half", button: "½" },
  1: { beats: "1", button: "1" },
  2: { beats: "2", button: "2×" },
  4: { beats: "4", button: "4×" },
  8: { beats: "8", button: "8×" },
}

function sameRange(first: DeckLoop | null | undefined, second: DeckLoop | null | undefined) {
  return first?.start === second?.start && first?.end === second?.end
}

export default function DeckLoopControls({ id, audio, bpm, beatTimes, quantize, pendingIn, setPendingIn,
  saved = false, saveLoop, exitLoop }: {
  id: DeckId
  audio: TransitionAudio
  bpm: number | null
  beatTimes: readonly number[]
  quantize: QuantizeMode
  pendingIn: number | null
  setPendingIn: (time: number | null) => void
  saved?: boolean
  saveLoop: (range: DeckLoop) => void
  exitLoop: () => void
}) {
  const { track, loop, loopArmed, loading } = audio.decks[id]
  const [recentByTrack, setRecentByTrack] = useState<ReadonlyMap<string, DeckLoop>>(() => new Map())
  const [lastUnidentified, setLastUnidentified] = useState<{ track: TransitionTrack; range: DeckLoop } | null>(null)
  const [estimated, setEstimated] = useState<{ range: DeckLoop; count: LoopFactor } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const key = track?.fingerprint ?? track?.libraryId ?? (track?.demo ? `demo:${track.name}` : null)
  const waiting = Boolean(loop && loopArmed && audio.positions[id] < loop.start)
  const liveLoop = waiting ? null : loop
  const recent = key ? recentByTrack.get(key) : lastUnidentified?.track === track ? lastUnidentified?.range : undefined

  const remember = useCallback((range: DeckLoop) => {
    if (!track) return
    if (key) setRecentByTrack(previous => {
      if (sameRange(previous.get(key), range)) return previous
      return new Map(previous).set(key, range)
    })
    else setLastUnidentified(previous => previous?.track === track && sameRange(previous.range, range)
      ? previous : { track, range })
  }, [key, track])

  useEffect(() => {
    setLastUnidentified(previous => previous?.track === track ? previous : null)
    setEstimated(null)
    setNotice(null)
  }, [track])

  useEffect(() => {
    if (loop && !waiting) remember(loop)
  }, [loop, waiting, remember])

  if (!track) return null
  const label = `Deck ${id}`
  const duration = track.buffer.duration
  const disabled = loading || audio.starting[id]
  const hasBeatLength = beatTimes.length >= 2 || (bpm !== null && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400)
  const displayedEstimate = loop && estimated && sameRange(estimated.range, loop) ? estimated.count : null

  function activate(range: DeckLoop, startAtIn = false) {
    if (!audio.setLoop(id, range, startAtIn)) {
      setNotice("This loop does not fit on the track.")
      return false
    }
    remember(range)
    setPendingIn(null)
    setNotice(null)
    return true
  }

  function capture(edge: LoopEdge) {
    const seconds = captureLoopEdge(audio.getPositions()[id], beatTimes, quantize, duration)
    if (seconds === null) {
      setNotice("Move the playhead into the audio.")
      return
    }
    if (edge === "start") {
      setPendingIn(seconds)
      setNotice(null)
    } else if (pendingIn !== null) {
      const range = normalizePerformanceLoop(pendingIn, seconds, duration)
      if (!range) setNotice("Out must be at least 50 ms after In.")
      else if (activate(range, true)) setEstimated(null)
    }
  }

  function changeLength(factor: LoopFactor) {
    if (liveLoop && factor !== 1) {
      const range = resizePerformanceLoop(liveLoop, factor, duration)
      if (!range) {
        setNotice(factor < 1 ? "This would make the loop shorter than 50 ms." : "This would extend the loop past the end of the track.")
      } else if (activate(range)) setEstimated(null)
      return
    }
    const anchor = liveLoop?.start ?? pendingIn ?? audio.getPositions()[id]
    const result = makeBeatLoop(anchor, factor, beatTimes, bpm, liveLoop || pendingIn !== null ? "off" : quantize, duration)
    if (!result) {
      setNotice("This beat loop needs a supported beat length and at least 50 ms within the track.")
      return
    }
    if (activate(result.range)) setEstimated(result.timing === "tempo" ? { range: result.range, count: factor } : null)
  }

  function togglePlayback() {
    if (loop) {
      if (!waiting) remember(loop)
      exitLoop()
      setNotice(null)
    } else if (recent) activate(recent, true)
  }

  const loopStatus = loop ? waiting ? "Armed" : audio.playing[id] ? "Looping" : "Loop set" : null
  const length = loop ? (loop.end - loop.start).toFixed(3) + " s" : null
  return <div className="deck-loop-controls" role="group" aria-label={label + " loop controls"}>
    <div className="deck-loop-heading">
      <strong>Loop</strong>
      {loop && <output className="deck-loop-status" aria-live="polite">
        {loopStatus} · {length}
        {displayedEstimate && ` · ${displayedEstimate < 1 ? loopLabels[displayedEstimate].button : displayedEstimate} beat${displayedEstimate > 1 ? "s" : ""} est.`}
        {saved && " · Saved"}
      </output>}
    </div>
    <div className="deck-loop-actions">
      <button className="quiet" type="button" disabled={disabled} aria-label={label + " loop In at playhead"}
        aria-pressed={pendingIn !== null} title="Capture loop In at the playhead" onClick={() => capture("start")}>In</button>
      <button className="quiet" type="button" disabled={disabled || pendingIn === null} aria-label={label + " loop Out at playhead"}
        title="Capture loop Out at the playhead and engage the loop" onClick={() => capture("end")}>Out</button>
      <button className="quiet" type="button" disabled={disabled || (!loop && !recent)}
        aria-label={(waiting ? "Disarm loop on " : loop ? "Exit loop on " : "Re-loop on ") + label}
        title={waiting ? "Cancel the pending live loop" : loop ? "Leave loop playback" : "Return to the last loop's In point"}
        onClick={togglePlayback}>{waiting ? "Disarm" : loop ? "Exit" : "Re-loop"}</button>
      {loop && <button className="quiet" type="button" disabled={disabled || saved} aria-label={"Save loop on " + label}
        onClick={() => saveLoop(loop)}>Save loop</button>}
    </div>
    {pendingIn !== null && <div className="deck-loop-pending">
      <output className="deck-loop-timing" aria-live="polite">In {formatTime(pendingIn, true)}</output>
      <button type="button" className="quiet" onClick={() => { setPendingIn(null); setNotice(null) }}>Cancel In</button>
    </div>}
    <div className="deck-loop-lengths">
      <div className="segments" role="group" aria-label={label + " loop length"}>
        {LOOP_FACTORS.map(factor => {
          const labels = loopLabels[factor]
          const relative = liveLoop !== null && factor !== 1
          const action = relative
            ? `Multiply current loop length by ${factor < 1 ? "one " + labels.beats : labels.beats}`
            : `Set a ${labels.beats}-beat loop`
          return <button type="button" key={factor} data-one-beat={factor === 1 || undefined}
            disabled={disabled || (!relative && !hasBeatLength)} aria-label={`${label}: ${action}`}
            title={action + (liveLoop || pendingIn !== null ? " at In" : " at the playhead")}
            onClick={() => changeLength(factor)}>{labels.button}</button>
        })}
      </div>
      <span className="deck-loop-beat-unit">{liveLoop ? "Resize at In" : "beats"}</span>
    </div>
    {notice && <p className="transition-note" role="status">{notice}</p>}
  </div>
}
