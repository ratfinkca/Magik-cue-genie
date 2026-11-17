import { useId, useRef } from "react"
import { cueColorNames } from "./studioPreferences"
import type { AnalysisPreferences, CueColorName, StudioPreferences } from "./studioPreferences"
import "./studioPreparationSettings.css"

export default function StudioPreparationSettings({ preferences, change }: {
  preferences: StudioPreferences
  change: (preferences: StudioPreferences) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const { analysis, cueColors } = preferences
  function changeAnalysis(patch: Partial<AnalysisPreferences>) {
    change({ ...preferences, analysis: { ...analysis, ...patch } })
  }
  function changeColor(name: CueColorName, color?: string) {
    change({ ...preferences, cueColors: { ...cueColors, [name]: color } })
  }

  return <>
    <button type="button" className="quiet" onClick={() => dialog.current?.showModal()}>Preferences</button>
    <dialog className="studio-preparation-settings" ref={dialog} aria-labelledby={heading}>
      <h2 id={heading}>Preparation preferences</h2>
      <fieldset>
        <legend>Cue colors</legend>
        <p>Cues with their own color keep it.</p>
        <div className="studio-color-preferences">
          {cueColorNames.map(name => <div className="studio-color-preference" key={name}>
            <label>{name}<input type="color" value={cueColors[name] ?? "#78f3c3"}
              onChange={event => changeColor(name, event.currentTarget.value)} /></label>
            <button type="button" className="quiet" aria-label={`Use deck color for ${name}`} disabled={!cueColors[name]}
              onClick={() => changeColor(name)}>Deck color</button>
          </div>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>Analysis suggestions</legend>
        <label>Minimum cue confidence
          <select value={analysis.minimumConfidence} onChange={event => {
            const value = event.currentTarget.value
            changeAnalysis({ minimumConfidence: value === "0.5" ? .5 : value === "0.6" ? .6 : 0 })
          }}>
            <option value={0}>Show all</option><option value={.5}>50%</option><option value={.6}>60%</option>
          </select>
        </label>
        <label>Emergency loops
          <select value={analysis.emergencyLoops} onChange={event => {
            const value = event.currentTarget.value
            changeAnalysis({ emergencyLoops: value === "off" || value === "suggest" ? value : "arm" })
          }}>
            <option value="arm">Suggest and arm</option><option value="suggest">Suggest unarmed</option><option value="off">Off</option>
          </select>
        </label>
        <label className="studio-preparation-check">
          <input type="checkbox" checked={analysis.vocalLoops}
            onChange={event => changeAnalysis({ vocalLoops: event.currentTarget.checked })} /> Suggest vocal loops
        </label>
        <p>Confidence is a heuristic score for new suggestions. Emergency loops need measured timing near the end of the track.</p>
      </fieldset>
      <form method="dialog"><button type="submit" className="quiet">Done</button></form>
    </dialog>
  </>
}
