import { useRef } from "react"
import { knobDragAngle, reflectedKnobValue } from "./knobGesture"
import type { KnobDrag } from "./knobGesture"
import { EQ_MAX_DB, EQ_MIN_DB } from "./transitionEq"

export default function EqKnob({
  label, name, value, disabled, change, min = EQ_MIN_DB, max = EQ_MAX_DB,
  scale = "centered", resetValue = 0, reflectOnTap = false,
  formatValue, resetGroup, hint = "Drag to adjust. Arrow keys change 1 dB. Double-click or press 0 to reset.",
}: {
  label: string
  name: string
  value: number
  disabled: boolean
  change: (db: number) => void
  min?: number
  max?: number
  scale?: "centered" | "linear"
  resetValue?: number
  reflectOnTap?: boolean
  formatValue?: (value: number) => string
  resetGroup?: () => void
  hint?: string
}) {
  const drag = useRef<KnobDrag | null>(null)
  const angle = scale === "linear" ? -135 + 270 * (value - min) / (max - min)
    : value < 0 ? -135 * value / min : 135 * value / max
  const valueLabel = formatValue?.(value) ?? (value > 0 ? "+" : "") + value + " dB"
  const set = (db: number) => change(Math.min(max, Math.max(min, db)))
  const reflect = () => set(reflectedKnobValue(value, min, max))
  function updateDrag(active: KnobDrag, pointer: number, x: number, y: number) {
    const rotation = knobDragAngle(active, pointer, x, y, reflectOnTap)
    if (rotation === null) return
    const next = Math.round(scale === "linear" ? min + (rotation + 135) / 270 * (max - min)
      : rotation < 0 ? -rotation * min / 135 : rotation * max / 135)
    if (next !== active.value) { active.value = next; set(next) }
  }

  return <div className="deck-knob">
    <span className="deck-knob-label">{label}</span>
    <div className="deck-knob-handle" role="slider" tabIndex={disabled ? undefined : 0}
      aria-label={name} aria-disabled={disabled} aria-valuemin={min} aria-valuemax={max}
      aria-valuenow={value} aria-valuetext={valueLabel}
      title={resetGroup ? hint + " Shift-double-click or Shift+Backspace resets all three EQ bands." : hint}
      aria-keyshortcuts={resetGroup ? "0 Shift+Backspace" : reflectOnTap ? "Space Enter 0" : undefined}
      onPointerDown={event => {
        if (disabled || drag.current || event.button !== 0) return
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, angle, value, moved: false }
      }}
      onPointerMove={event => {
        const active = drag.current
        if (disabled || !active) return
        updateDrag(active, event.pointerId, event.clientX, event.clientY)
      }}
      onPointerUp={event => {
        const active = drag.current
        if (active?.pointer !== event.pointerId) return
        drag.current = null
        if (disabled || !reflectOnTap) return
        updateDrag(active, event.pointerId, event.clientX, event.clientY)
        if (!active.moved) reflect()
      }}
      onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) drag.current = null }}
      onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) drag.current = null }}
      onDoubleClick={event => {
        if (disabled || reflectOnTap) return
        if (event.shiftKey && resetGroup) resetGroup()
        else set(resetValue)
      }}
      onKeyDown={event => {
        if (disabled) return
        if (reflectOnTap && (event.key === " " || event.key === "Enter")) {
          event.preventDefault()
          if (!event.repeat) reflect()
          return
        }
        if (event.shiftKey && resetGroup && event.key === "Backspace") {
          event.preventDefault()
          resetGroup()
          return
        }
        let next: number
        switch (event.key) {
          case "ArrowUp": case "ArrowRight": next = value + 1; break
          case "ArrowDown": case "ArrowLeft": next = value - 1; break
          case "PageUp": next = value + 6; break
          case "PageDown": next = value - 6; break
          case "Home": next = min; break
          case "End": next = max; break
          case "0": next = resetValue; break
          default: return
        }
        event.preventDefault()
        set(next)
      }}>
      <span className="deck-knob-pointer" aria-hidden="true" style={{ transform: "rotate(" + angle + "deg)" }} />
    </div>
    <output aria-hidden="true">{valueLabel}</output>
  </div>
}
