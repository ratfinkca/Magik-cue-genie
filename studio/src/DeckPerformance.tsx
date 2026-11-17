import type { CSSProperties } from "react"
import type { DeckId, useTransitionAudio } from "./transitionAudio"
import { PITCH_MIN_PERCENT, PITCH_MAX_PERCENT } from "./transitionMixer"

type TransitionAudio = ReturnType<typeof useTransitionAudio>
export type PitchRange = "8" | "16" | "wide"

export function pitchBounds(range: PitchRange, rate: number): [number, number] {
  if (range === "wide" || Math.abs(rate - 100) > 16) return [PITCH_MIN_PERCENT, PITCH_MAX_PERCENT]
  return range === "16" || Math.abs(rate - 100) > 8 ? [84, 116] : [92, 108]
}

export default function DeckPerformance({
  id, audio, bpm, range, changeRange, syncLabel, syncAvailable, tapMode = false, tapStatus, followStatus, syncHeld, changeTempo, sync,
}: {
  id: DeckId
  audio: TransitionAudio
  bpm: number | null
  range: PitchRange
  changeRange: (range: PitchRange) => void
  syncLabel: string
  syncAvailable: boolean
  tapMode?: boolean
  tapStatus?: string
  followStatus?: string
  syncHeld: boolean
  changeTempo: (rate: number) => void
  sync: () => void
}) {
  const deck = audio.decks[id]
  const label = "Deck " + id
  const disabled = !deck.track || deck.loading
  const syncName = tapMode ? "Tap Sync" : "Sync"
  const tapHintId = tapMode && !disabled ? "deck-tap-status-" + id : undefined
  const rate = Number(deck.speed)
  const offset = rate - 100
  const offsetLabel = (offset > 0 ? "+" : "") + offset.toFixed(2) + "%"
  const bpmLabel = bpm === null ? null : (bpm * rate / 100).toFixed(1)
  const [min, max] = pitchBounds(range, rate)
  const unity = (100 - min) / (max - min) * 100

  return (
    <div className="deck-performance" data-deck={id} role="group" aria-label={label + " tempo controls"}>
      <div className="deck-pitch">
        <div className="deck-tempo-caption">
          <label htmlFor={"deck-pitch-" + id}>Tempo <output>{offsetLabel}</output></label>
          <select className="deck-pitch-range" aria-label={label + " tempo range"} title="Tempo fader range for both decks"
            value={range} onChange={event => changeRange(event.currentTarget.value as PitchRange)}>
            <option value="8">±8%</option>
            <option value="16">±16%</option>
            <option value="wide">Wide</option>
          </select>
          <span className="deck-performance-bpm" aria-label={label + " playback BPM"}>
            <strong>{bpmLabel ?? "—"}</strong> BPM
          </span>
        </div>
        <div className="fader-shell pitch-fader" style={{ "--unity": unity + "%" } as CSSProperties}>
          <div className="fader-bed" aria-hidden="true"><i className="pitch-unity" /></div>
          <input id={"deck-pitch-" + id} type="range" min={min} max={max} step=".01"
            value={rate} disabled={disabled} aria-label={label + " tempo"} aria-valuetext={offsetLabel}
            title={deck.keyLock ? "Changes tempo with the original key held. Double-click to reset."
              : "Changes tempo and pitch together. Double-click to reset."}
            onChange={event => changeTempo(Number(event.target.value))}
            onDoubleClick={() => changeTempo(100)} />
        </div>
        <div className="pitch-scale" aria-hidden="true">
          <span>{min - 100}%</span><span>+{max - 100}%</span>
        </div>
      </div>
      <div className="deck-performance-actions">
        <button className="quiet" type="button" disabled={disabled || (!tapMode && !syncAvailable && !syncHeld)}
          aria-label={syncName + " " + label} aria-pressed={tapMode ? undefined : syncHeld} aria-describedby={tapHintId}
          title={tapMode ? "Tap at least 3 beats in rhythm."
            : syncAvailable || syncHeld ? syncLabel : "Set a sync reference and analyze a track tempo first."} onClick={sync}>
          {syncName}
        </button>
        <button className="quiet" type="button" aria-label={label + " Key Lock"} aria-pressed={deck.keyLock}
          aria-busy={deck.keyLockPending} disabled={disabled || deck.keyLockPending || !audio.keyLockAvailable}
          title={audio.keyLockAvailable ? "Keep the original key while changing BPM."
            : "Key Lock requires a browser with AudioWorklet support."}
          onClick={() => void audio.setKeyLock(id, !deck.keyLock)}>{deck.keyLockPending ? "Preparing…" : "Key Lock"}</button>
        <button className="quiet" type="button" disabled={disabled || (rate === 100 && !syncHeld)}
          aria-label={"Reset " + label + " tempo"} onClick={() => changeTempo(100)}>Reset tempo</button>
      </div>
      {tapHintId && <p id={tapHintId} className="deck-follow-status" role="status">{tapStatus ?? "Tap at least 3 beats"}</p>}
      {followStatus && <p className="deck-follow-status" role="status">{followStatus}</p>}
      {deck.keyLockError && <p className="transition-note" data-error="true" role="status">{deck.keyLockError}</p>}
    </div>
  )
}
