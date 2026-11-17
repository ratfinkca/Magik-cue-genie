import type { MidiTarget } from "./midiPreferences"

const deckButtons = [
  ["play", "Play / pause"], ["start-cue", "Pause at start cue"], ["sync", "Sync / tap sync"], ["key-lock", "Key Lock"],
  ["loop-in", "Loop In"], ["loop-out", "Loop Out"], ["loop-beat", "One-beat loop"],
  ["loop-half", "Halve loop"], ["loop-double", "Double loop"], ["loop-exit", "Exit loop"], ["fx", "FX on / off"],
  ["loop-four", "Four-beat loop / exit"],
  ...([4, 8, 16, 32] as const).map(beats => [`loop-size-${beats}`, `${beats}-beat loop / exit`] as const),
  ...([1, 2, 3, 4] as const).map(slot => [`loop-saved-${slot}`, `Saved loop ${slot}`] as const),
  ...Array.from({ length: 8 }, (_, index) => [`hot-${index + 1}`, `Hot cue ${index + 1}`]),
] as const
const deckAxes = [
  ["tempo", "Tempo fader"], ["gain", "Gain"], ["volume", "Channel volume"], ["pan", "Pan"], ["filter", "Filter"],
  ["low", "Low EQ"], ["mid", "Mid EQ"], ["high", "High EQ"], ["fx-mix", "FX Mix"],
  ["vocals", "Vocals level"], ["drums", "Drums level"], ["bass", "Bass level"], ["other", "Other stems level"],
] as const

export const studioMidiTargets: readonly MidiTarget[] = [
  ...(["A", "B"] as const).flatMap(deck => {
    const group = deck === "A" ? "Deck A" as const : "Deck B" as const
    return [
      ...deckButtons.map(([id, label]) => ({ id: `${deck}:${id}`, label, group, kind: "button" as const })),
      ...deckAxes.map(([id, label]) => ({ id: `${deck}:${id}`, label, group, kind: "absolute" as const })),
    ]
  }),
  { id: "M:crossfader", label: "Crossfader", group: "Mixer", kind: "absolute" },
  { id: "M:master", label: "Master Out", group: "Mixer", kind: "absolute" },
]

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)) }

export function midiAxis(current: number, min: number, max: number, update: (value: number) => void, center?: number, step = 1) {
  // Detented MIDI controls normally report 64 at center.
  const midpoint = 64 / 127
  function toPosition(value: number) {
    const limited = clamp(value, min, max)
    if (center === undefined) return (limited - min) / (max - min)
    if (limited <= center) return midpoint * (limited - min) / (center - min)
    return midpoint + (1 - midpoint) * (limited - center) / (max - center)
  }
  function set(position: number) {
    const value = center === undefined ? min + (max - min) * position
      : position <= midpoint ? min + (center - min) * position / midpoint
        : center + (max - center) * (position - midpoint) / (1 - midpoint)
    const applied = clamp(Number((Math.round(value / step) * step).toFixed(4)), min, max)
    update(applied)
    return toPosition(applied)
  }
  return { position: toPosition(current), set, centered: center !== undefined }
}
