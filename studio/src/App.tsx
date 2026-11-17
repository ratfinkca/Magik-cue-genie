import { useState } from "react"
import type { KeyNotation } from "./key"
import TransitionPreview from "./TransitionPreview"

function loadKeyNotation(): KeyNotation {
  try {
    const notation = localStorage.getItem("magik.keyNotation")
    if (notation === "camelot" || notation === "open") return notation
  } catch { /* Storage is optional. */ }
  return "standard"
}

export default function App() {
  const [keyNotation, setKeyNotation] = useState<KeyNotation>(loadKeyNotation)
  function changeKeyNotation(notation: KeyNotation) {
    setKeyNotation(notation)
    try { localStorage.setItem("magik.keyNotation", notation) } catch { /* Storage is optional. */ }
  }

  return <div className="studio">
    <TransitionPreview keyNotation={keyNotation} setKeyNotation={changeKeyNotation} />
  </div>
}
