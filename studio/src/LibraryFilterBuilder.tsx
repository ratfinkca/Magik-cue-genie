import { PlusIcon, XIcon } from "@phosphor-icons/react"
import { isNumericLibraryField, LIBRARY_FILTER_FIELDS, newLibraryFilterRule } from "./libraryFilters"
import type { LibraryFilterField, LibraryFilterRule, LibraryMatchMode, TextCondition } from "./libraryFilters"

const fields = Object.keys(LIBRARY_FILTER_FIELDS) as LibraryFilterField[]

export default function LibraryFilterBuilder({ rules, invalid, mode, onMode, onAdd, onClear, onRemove, onRule }: {
  rules: LibraryFilterRule[]
  invalid: ReadonlySet<number>
  mode: LibraryMatchMode
  onMode: (mode: LibraryMatchMode) => void
  onAdd: () => void
  onClear: () => void
  onRemove: (id: number) => void
  onRule: (rule: LibraryFilterRule) => void
}) {
  return <div className="track-library-filter-builder" role="group" aria-label="Track filter rules">
    <div className="track-library-filter-actions">
      <label>Match
        <select aria-label="Match filter rules" value={mode} onChange={event => onMode(event.currentTarget.value as LibraryMatchMode)}>
          <option value="all">All rules</option><option value="any">Any rule</option>
        </select>
      </label>
      <button type="button" className="quiet" onClick={onAdd}><PlusIcon aria-hidden="true" /> Add rule</button>
      <button type="button" className="quiet" disabled={!rules.length} onClick={onClear}>Clear filters</button>
    </div>
    {rules.map((rule, index) => {
      const prefix = "Rule " + (index + 1)
      const number = isNumericLibraryField(rule.field)
      const isEnergy = rule.field === "energy"
      const unit = rule.field === "duration" ? "seconds" : isEnergy ? "energy" : "BPM"
      const invalidRange = invalid.has(rule.id)
      return <div className="track-library-filter-rule" key={rule.id} data-filter-field={rule.field}>
        <select aria-label={prefix + " column"} value={rule.field}
          onChange={event => onRule(newLibraryFilterRule(rule.id, event.currentTarget.value as LibraryFilterField))}>
          {fields.map(field => <option key={field} value={field}>{LIBRARY_FILTER_FIELDS[field]}</option>)}
        </select>
        {number ? <div className="track-library-filter-values">
          <input type="number" min={isEnergy ? 1 : 0} max={isEnergy ? 10 : undefined} step={isEnergy ? 1 : "any"}
            value={rule.value} placeholder={"Min " + unit} data-filter-value
            aria-label={prefix + " minimum " + unit} aria-invalid={invalidRange}
            onChange={event => onRule({ ...rule, value: event.currentTarget.value })} />
          <input type="number" min={isEnergy ? 1 : 0} max={isEnergy ? 10 : undefined} step={isEnergy ? 1 : "any"}
            value={rule.maximum} placeholder={"Max " + unit}
            aria-label={prefix + " maximum " + unit} aria-invalid={invalidRange}
            onChange={event => onRule({ ...rule, maximum: event.currentTarget.value })} />
          {invalidRange && <p className="track-library-filter-warning">Enter a valid range.</p>}
        </div> : rule.field === "prepared" ? <select value={rule.value} aria-label={prefix + " preparation"} data-filter-value
          onChange={event => onRule({ ...rule, value: event.currentTarget.value })}>
          <option value="yes">Prepared</option><option value="no">Unprepared</option>
        </select> : <div className="track-library-filter-values">
          <select value={rule.condition} aria-label={prefix + " condition"}
            onChange={event => onRule({ ...rule, condition: event.currentTarget.value as TextCondition })}>
            <option value="contains">Contains</option><option value="is">Is</option><option value="missing">Is missing</option>
          </select>
          {rule.condition !== "missing" && <input type="text" value={rule.value} data-filter-value
            aria-label={prefix + " " + LIBRARY_FILTER_FIELDS[rule.field]} placeholder={LIBRARY_FILTER_FIELDS[rule.field]}
            onChange={event => onRule({ ...rule, value: event.currentTarget.value })} />}
        </div>}
        <button type="button" className="quiet track-library-icon" aria-label={"Remove " + prefix.toLowerCase()}
          onClick={() => onRemove(rule.id)}><XIcon aria-hidden="true" /></button>
      </div>
    })}
  </div>
}
