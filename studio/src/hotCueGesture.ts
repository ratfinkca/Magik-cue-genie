export type HotCueMode = "instant" | "release" | "hold"
export type HotCueGestureEnd = "release" | "cancel"
export type HotCueFinish = (reason: HotCueGestureEnd) => void
export type HotCueActivationKey = " " | "Enter"
export type HotCueInput = { kind: "pointer"; id: number } | { kind: "keyboard"; key: HotCueActivationKey }

function sameInput(first: HotCueInput, second: HotCueInput) {
  return first.kind === "pointer" ? second.kind === "pointer" && first.id === second.id
    : second.kind === "keyboard" && first.key === second.key
}

/** One pad owns a deck's press. Drop ownership before cleanup so capture loss cannot finish it twice. */
export function createHotCueGesture<Owner>() {
  let active: { owner: Owner; input: HotCueInput; end: HotCueFinish } | null = null

  function end(reason: HotCueGestureEnd) {
    const held = active
    active = null
    held?.end(reason)
    return Boolean(held)
  }

  return {
    owner: () => active?.owner,
    begin(owner: Owner, input: HotCueInput, start: () => HotCueFinish | undefined) {
      if (active?.owner === owner && sameInput(active.input, input)) return
      end("cancel")
      const finish = start()
      if (finish) active = { owner, input, end: finish }
    },
    finish(owner: Owner, input: HotCueInput, reason: HotCueGestureEnd) {
      return active?.owner === owner && sameInput(active.input, input) && end(reason)
    },
    cancel(owner?: Owner) {
      return (owner === undefined || active?.owner === owner) && end("cancel")
    },
  }
}
