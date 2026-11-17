import type { ControllerPadMode, MidiBinding } from "./midiPreferences"
import type { MidiControl } from "./midiMapping"

type Deck = "A" | "B"
export type ControllerPresetId = "ddj-flx4" | "mixstream-pro-go"

export type ControllerPreset = {
  id: ControllerPresetId
  label: string
  description: string
  setup: string
  bindings: readonly Omit<MidiBinding, "inputId">[]
  shifts?: Partial<Record<Deck, MidiControl>>
  modes?: readonly { deck: Deck; control: MidiControl; mode: ControllerPadMode }[]
}

const decks: readonly Deck[] = ["A", "B"]

function note(channel: number, number: number): MidiControl {
  return { kind: "note", channel, number }
}

function cc(channel: number, number: number, lsb?: number): MidiControl {
  return lsb === undefined ? { kind: "cc", channel, number } : { kind: "cc", channel, number, lsb }
}

// Protocol addresses from AlphaTheta's DDJ-FLX4 List of MIDI Messages, version 1.0.
// https://downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-FLX4/DDJ-FLX4_MIDI_message_List_E1.pdf
const flx4Bindings: ControllerPreset["bindings"] = [
  ...decks.flatMap((deck, index) => {
    const channel = index + 1
    const buttons = [
      ["play", 0x0b], ["start-cue", 0x0c], ["sync", 0x58],
      ["loop-in", 0x10], ["loop-out", 0x11], ["loop-four", 0x4d],
      ["loop-half", 0x51], ["loop-double", 0x53], ["loop-exit", 0x50],
    ] as const
    const axes = [
      ["tempo", 0x00, 0x20], ["gain", 0x04, 0x24], ["high", 0x07, 0x27],
      ["mid", 0x0b, 0x2b], ["low", 0x0f, 0x2f], ["volume", 0x13, 0x33],
    ] as const
    return [
      ...buttons.map(([action, number]) => ({ actionId: `${deck}:${action}`, control: note(channel, number) })),
      ...axes.map(([action, msb, lsb]) => ({ actionId: `${deck}:${action}`, control: cc(channel, msb, lsb) })),
      { actionId: `${deck}:filter`, control: cc(7, 0x17 + index, 0x37 + index) },
      ...Array.from({ length: 8 }, (_, pad) => ({
        actionId: `${deck}:hot-${pad + 1}`, control: note(index === 0 ? 8 : 10, pad),
      })),
    ]
  }),
  { actionId: "M:crossfader", control: cc(7, 0x1f, 0x3f) },
  { actionId: "M:master", control: cc(7, 0x08, 0x28) },
]

// Protocol facts independently expressed from the maintained Mixxx hardware mapping.
// https://github.com/mixxxdj/mixxx/blob/7660154896e72d7f2c2f64035830f6501052b07d/res/controllers/Numark-Mixstream-Pro.midi.xml
// Go model support is documented in Mixxx's Numark Mixstream Pro manual.
const mixstreamBindings: ControllerPreset["bindings"] = [
  ...decks.flatMap((deck, index) => {
    const mixerChannel = index + 1
    const deckChannel = index + 3
    const buttons = [["play", 0x0a], ["start-cue", 0x09], ["sync", 0x08]] as const
    const axes = [
      ["gain", 0x03], ["high", 0x04], ["mid", 0x06],
      ["low", 0x08], ["filter", 0x0b], ["volume", 0x0e],
    ] as const
    return [
      ...buttons.map(([action, number]) => ({ actionId: `${deck}:${action}`, control: note(deckChannel, number) })),
      ...axes.map(([action, number]) => ({ actionId: `${deck}:${action}`, control: cc(mixerChannel, number) })),
      { actionId: `${deck}:tempo`, control: cc(deckChannel, 0x1f, 0x4b) },
      ...Array.from({ length: 4 }, (_, pad) => {
        const control = note(deckChannel, 0x0f + pad)
        return [
          { actionId: `${deck}:hot-${pad + 1}`, control, when: { deck, mode: "hotcue" as const, shift: false } },
          { actionId: `${deck}:hot-${pad + 5}`, control, when: { deck, mode: "hotcue" as const, shift: true } },
          { actionId: `${deck}:loop-size-${[4, 8, 16, 32][pad]}`, control,
            when: { deck, mode: "autoloop" as const, shift: false } },
          { actionId: `${deck}:${["loop-half", "loop-double", "loop-beat", "loop-exit"][pad]}`, control,
            when: { deck, mode: "autoloop" as const, shift: true } },
          { actionId: `${deck}:loop-saved-${pad + 1}`, control, when: { deck, mode: "savedloop" as const } },
        ]
      }).flat(),
    ]
  }),
  { actionId: "M:crossfader", control: cc(16, 0x0e) },
  { actionId: "M:master", control: cc(16, 0x0f) },
]

export const controllerPresets: readonly ControllerPreset[] = [
  {
    id: "ddj-flx4",
    label: "Pioneer DJ DDJ-FLX4",
    description: "Two decks, mixer, eight hot cues per deck, and loop controls.",
    setup: "Connect the rear device USB port and select HOT CUE pad mode. The cue/loop call buttons halve and double loops. Shift + 4 BEAT/EXIT exits a loop.",
    bindings: flx4Bindings,
  },
  {
    id: "mixstream-pro-go",
    label: "Numark Mixstream Pro Go",
    description: "Computer Mode decks and mixer, with Hot Cue, Auto Loop, and Saved Loop pad modes.",
    setup: "Connect USB to your computer, then choose Source → Computer Mode on the controller. Hold Shift for hot cues 5–8. In Auto Loop mode, Shift + pads halve, double, set one beat, or exit the loop.",
    bindings: mixstreamBindings,
    shifts: { A: note(3, 0x1c), B: note(4, 0x1c) },
    modes: decks.flatMap((deck, index) => [
      { deck, control: note(index + 3, 0x0b), mode: "hotcue" as const },
      { deck, control: note(index + 3, 0x0c), mode: "savedloop" as const },
      { deck, control: note(index + 3, 0x0d), mode: "roll" as const },
      { deck, control: note(index + 3, 0x0e), mode: "autoloop" as const },
    ]),
  },
]

export function detectControllerPreset(input: { name: string; manufacturer: string }): ControllerPreset | undefined {
  const model = `${input.manufacturer} ${input.name}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")
  const id = /\bddj\s*flx4\b/.test(model) ? "ddj-flx4"
    : /\bmixstream\s*pro\s*go\b/.test(model) ? "mixstream-pro-go" : undefined
  return controllerPresets.find(preset => preset.id === id)
}
