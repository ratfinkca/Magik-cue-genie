import { useState } from "react"
import type { RefObject } from "react"
import EqKnob from "./EqKnob"
import StereoMeter from "./StereoMeter"
import { MASTER_MAX_DB, MASTER_MIN_DB } from "./transitionAudio"
import type { DeckId } from "./transitionAudio"
import {
  DECK_FX_KINDS, FX_DELAY_MS_RANGE, FX_FEEDBACK_RANGE, FX_MIX_RANGE,
  FX_FLANGER_DEPTH_RANGE, FX_FLANGER_RATE_RANGE,
  FX_ROOM_DAMPING_RANGE, FX_ROOM_PREDELAY_RANGE, FX_TREMOLO_DEPTH_RANGE, FX_TREMOLO_RATE_RANGE,
} from "./transitionFx"
import type { DeckFxKind, DeckFxSettings } from "./transitionFx"
import "./mixerExtras.css"

const mixerDecks = ["A", "B"] as const
const effectNames: Record<DeckFxKind, string> = {
  echo: "Echo", pingPong: "Ping Pong Delay", room: "Room Reverb", flanger: "Flanger", tremolo: "Tremolo",
}
const echoBeats = [
  { ratio: .25, label: "¼" }, { ratio: .5, label: "½" }, { ratio: .75, label: "¾" }, { ratio: 1, label: "1" },
]

type Parameter = {
  name: keyof Omit<DeckFxSettings, "kind" | "enabled" | "mix">
  label: string
  range: readonly [number, number]
  unit: "%" | " ms" | " Hz"
  step?: number
}

const parameters: Record<DeckFxKind, readonly Parameter[]> = {
  echo: [
    { name: "delayMs", label: "Delay", range: FX_DELAY_MS_RANGE, unit: " ms" },
    { name: "feedback", label: "Feedback", range: FX_FEEDBACK_RANGE, unit: "%" },
  ],
  pingPong: [
    { name: "pingPongDelayMs", label: "Delay", range: FX_DELAY_MS_RANGE, unit: " ms" },
    { name: "pingPongFeedback", label: "Feedback", range: FX_FEEDBACK_RANGE, unit: "%" },
  ],
  room: [
    { name: "roomPredelayMs", label: "Pre-delay", range: FX_ROOM_PREDELAY_RANGE, unit: " ms" },
    { name: "roomDamping", label: "Damping", range: FX_ROOM_DAMPING_RANGE, unit: "%" },
  ],
  tremolo: [
    { name: "tremoloRateHz", label: "Rate", range: FX_TREMOLO_RATE_RANGE, unit: " Hz", step: .1 },
    { name: "tremoloDepth", label: "Depth", range: FX_TREMOLO_DEPTH_RANGE, unit: "%" },
  ],
  flanger: [
    { name: "flangerRateHz", label: "Rate", range: FX_FLANGER_RATE_RANGE, unit: " Hz", step: .05 },
    { name: "flangerDepth", label: "Depth", range: FX_FLANGER_DEPTH_RANGE, unit: "%" },
  ],
}

export function MixerMasterOut({ value, onChange, meterRef }: {
  value: number
  onChange: (value: number) => void
  meterRef: RefObject<HTMLDivElement | null>
}) {
  return <section className="mixer-master-out" aria-label="Master output">
    <EqKnob label="Master Out" name="Master Out" value={value} disabled={false} change={onChange}
      min={MASTER_MIN_DB} max={MASTER_MAX_DB}
      formatValue={db => db <= MASTER_MIN_DB ? "Mute" : (db > 0 ? "+" : "") + db + " dB"} />
    <div className="mixer-master-meter">
      <span>Peak · dBFS</span>
      <StereoMeter label="Master" meterRef={meterRef} title="Peak level after Master Out and output protection." />
    </div>
  </section>
}

export function ChannelFxControls({ id, fx, onChange, disabled = false }: {
  id: DeckId
  fx: DeckFxSettings
  onChange: (patch: Partial<DeckFxSettings>) => void
  disabled?: boolean
}) {
  const deck = "Deck " + id
  return <div className="channel-fx-controls" data-deck={id} role="group" aria-label={deck + " effects"}>
    <EqKnob label="FX Mix" name={deck + " FX mix"} value={fx.mix} disabled={disabled}
      min={FX_MIX_RANGE[0]} max={FX_MIX_RANGE[1]} scale="linear" reflectOnTap
      change={mix => onChange({ mix })} formatValue={mix => mix + "%"}
      hint="Drag to blend dry and wet. Click, tap, or press Space to invert the percentage. Press 0 for dry." />
    <button className="quiet channel-fx-toggle" type="button" disabled={disabled} aria-label={deck + " FX"}
      title={effectNames[fx.kind]}
      aria-pressed={fx.enabled} onClick={() => onChange({ enabled: !fx.enabled })}>
      {fx.enabled ? "FX on" : "FX off"}
    </button>
  </div>
}

export function MixerEffects({ fx, bpm, onChange }: {
  fx: Record<DeckId, DeckFxSettings>
  bpm: Record<DeckId, number | null>
  onChange: (id: DeckId, patch: Partial<DeckFxSettings>) => void
}) {
  const [deck, setDeck] = useState<DeckId>("A")
  const settings = fx[deck]
  const effect = effectNames[settings.kind]
  const tempo = bpm[deck]
  const delaySetting = settings.kind === "echo" ? "delayMs" : settings.kind === "pingPong" ? "pingPongDelayMs" : null

  return <section className="mixer-effects" data-deck={deck} aria-label={"Deck " + deck + " FX settings"}>
    <div className="mixer-effects-header">
      <h3>Effects</h3>
      <div className="segments" role="group" aria-label="FX deck">
        {mixerDecks.map(id => <button key={id} type="button" aria-pressed={deck === id}
          aria-label={"Edit Deck " + id + " FX"} onClick={() => setDeck(id)}>{id}</button>)}
      </div>
    </div>
    <div className="mixer-effect-picker">
      <select aria-label={"Deck " + deck + " effect"} value={settings.kind}
        onChange={event => onChange(deck, { kind: event.currentTarget.value as DeckFxKind })}>
        {DECK_FX_KINDS.map(kind => <option key={kind} value={kind}>{effectNames[kind]}</option>)}
      </select>
    </div>
    {delaySetting && <div className="mixer-beat-preset">
      <span>Delay in beats</span>
      <div className="segments" role="group" aria-label={effect + " beat presets"}>
        {echoBeats.map(({ ratio, label }) => {
          const delayMs = tempo && tempo > 0 ? Math.round(60_000 * ratio / tempo) : null
          const available = delayMs !== null && delayMs >= FX_DELAY_MS_RANGE[0] && delayMs <= FX_DELAY_MS_RANGE[1]
          return <button key={ratio} type="button" disabled={!available} aria-label={label + " beat " + effect}
            aria-pressed={available && settings[delaySetting] === delayMs}
            title={available ? "Set delay to " + delayMs + " ms at the current deck tempo"
              : tempo ? "This beat length is outside the delay range" : "Analyze the track to set its deck tempo"}
            onClick={() => { if (available) onChange(deck, { [delaySetting]: delayMs }) }}>{label}</button>
        })}
      </div>
    </div>}
    <div className="mixer-effects-fields">
      {parameters[settings.kind].map(({ name, label, range, unit, step = 1 }) => {
        const value = settings[name]
        return <label key={name}>
          <span>{label} <output aria-hidden="true">{value}{unit}</output></span>
          <input type="range" aria-label={effect + " " + label.toLowerCase()} aria-valuetext={value + unit}
            min={range[0]} max={range[1]} step={step} value={value}
            onChange={event => onChange(deck, { [name]: event.currentTarget.valueAsNumber })} />
        </label>
      })}
    </div>
  </section>
}
