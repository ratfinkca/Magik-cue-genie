import type { CSSProperties } from "react"
import { useId } from "react"
import { CROSSFADER_CURVES, getCrossfaderMarks } from "./transitionMixer"
import type { CrossfaderCurve, CrossfaderCustom } from "./transitionMixer"
import "./crossfader.css"

export default function Crossfader({ position, curve, custom, change }: {
  position: number
  curve: CrossfaderCurve
  custom: CrossfaderCustom
  change: (position: number) => void
}) {
  const inputId = useId()
  const label = position === 0 ? "Deck A" : position === 100 ? "Deck B"
    : position === 50 ? "Center" : position + "% toward Deck B"
  const config = CROSSFADER_CURVES[curve]
  const marks = getCrossfaderMarks(curve, custom).filter(mark =>
    mark > 0 && mark < 100 && (mark === 50 || Math.abs(mark - 50) >= 6))
  return (
    <div className="transition-fader">
      <div className="crossfader-caption">
        <label htmlFor={inputId}>Crossfader</label>
        <span>{config.label}</span>
      </div>
      <div className="crossfader-control">
        <span className="crossfader-deck" data-deck="A" aria-hidden="true">A</span>
        <div className="crossfader-rail" style={{ "--position": position + "%" } as CSSProperties}>
          <div className="crossfader-bed" aria-hidden="true"><span className="crossfader-grip" /></div>
          <input className="crossfader-input" id={inputId} type="range" min={0} max={100} step={1} value={position}
            aria-valuetext={label} aria-description={config.label + " curve. Double-click to center."}
            title="Double-click to center"
            onChange={event => change(event.currentTarget.valueAsNumber)}
            onDoubleClick={() => change(50)} />
        </div>
        <div className="crossfader-scale" aria-hidden="true">
          {marks.map(mark => (
            <span key={mark} className="crossfader-tick" data-center={mark === 50}
              style={{ "--mark": mark + "%" } as CSSProperties}>{mark}</span>
          ))}
        </div>
        <span className="crossfader-deck" data-deck="B" aria-hidden="true">B</span>
      </div>
    </div>
  )
}
