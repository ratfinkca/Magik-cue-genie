export type KnobDrag = {
  pointer: number
  x: number
  y: number
  angle: number
  value: number
  moved: boolean
}

export function knobDragAngle(drag: KnobDrag, pointer: number, x: number, y: number, waitForDrag: boolean): number | null {
  if (drag.pointer !== pointer) return null
  const dx = x - drag.x
  const dy = drag.y - y
  if (waitForDrag && !drag.moved && Math.hypot(dx, dy) < 4) return null
  drag.moved = true
  return Math.min(135, Math.max(-135, drag.angle + 2.4 * dy + 1.2 * dx))
}

export function reflectedKnobValue(value: number, min: number, max: number): number {
  return min + (max - value)
}
