import { useEffect, useMemo, useRef } from "react"
import type { RefObject } from "react"
import { METER_FLOOR_DB as floor } from "./levelMeter"
import type { MixerLevels } from "./levelMeter"
import "./stereoMeter.css"

const meterIds = ["A", "B", "master"] as const
const sides = ["left", "right"] as const
export function useStudioMeters(read: () => MixerLevels, active: boolean, hasFxTail: boolean) {
  const A = useRef<HTMLDivElement>(null)
  const B = useRef<HTMLDivElement>(null)
  const master = useRef<HTMLDivElement>(null)
  const meters = useMemo(() => ({ A, B, master }), [])

  useEffect(() => {
    const displayed: MixerLevels = {
      A: { left: floor, right: floor }, B: { left: floor, right: floor }, master: { left: floor, right: floor },
    }
    let frame = 0
    let sampledAt = 0
    let lastSignalAt = performance.now()
    function paint(levels: MixerLevels, fall: number) {
      for (const id of meterIds) {
        const meter = meters[id].current
        for (const side of sides) {
          const input = levels[id][side]
          const level = Number.isFinite(input) ? Math.max(floor, Math.min(0, input)) : floor
          const held = displayed[id][side] = Math.max(level, displayed[id][side] - fall)
          meter?.style.setProperty("--" + side, ((held - floor) / -floor * 100).toFixed(1) + "%")
          const rail = meter?.querySelector('[data-side="' + side + '"]')
          const rounded = Math.round(held)
          if (rail?.getAttribute("aria-valuenow") !== String(rounded)) rail?.setAttribute("aria-valuenow", String(rounded))
        }
      }
    }
    if (!active && !hasFxTail) {
      paint(displayed, 0)
      return
    }
    function tick(now: number) {
      const elapsed = sampledAt ? now - sampledAt : 40
      if (elapsed >= 33) {
        const levels = read()
        if (meterIds.some(id => levels[id].left > floor || levels[id].right > floor)) lastSignalAt = now
        paint(levels, elapsed * .032)
        sampledAt = now
      }
      // A silent gap can be as long as the echo's maximum delay.
      if (active || now - lastSignalAt <= 1_050 || meterIds.some(id => displayed[id].left > floor || displayed[id].right > floor)) {
        frame = requestAnimationFrame(tick)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active, hasFxTail, meters, read])

  return meters
}

export default function StereoMeter({ label, meterRef, title, showScale = false }: {
  label: string
  meterRef: RefObject<HTMLDivElement | null>
  title: string
  showScale?: boolean
}) {
  return <div className="stereo-meter" ref={meterRef} role="group" aria-label={label + " stereo meter"} title={title}>
    {showScale && <div className="stereo-meter-head">
      <strong>{label}</strong>
      <span aria-hidden="true">Peak · dBFS</span>
    </div>}
    {sides.map(side => <div className="stereo-meter-line" key={side}>
      <span aria-hidden="true">{side === "left" ? "L" : "R"}</span>
      <div role="meter" aria-label={label + " " + side + " peak in dBFS"} aria-valuemin={floor}
        aria-valuemax={0} aria-valuenow={floor} className="stereo-meter-rail" data-side={side}>
        <div className="stereo-meter-fill" aria-hidden="true" />
      </div>
    </div>)}
  </div>
}
