import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react"
import { getDeckFollowUpdate, makeDeckFollow } from "./deckSync"
import type { DeckFollowLink, DeckSyncPair } from "./deckSync"
import type { DeckId } from "./transitionAudio"

export type DeckSyncMode = "one-shot" | "follow"

const modePreference = "magik.studio.syncMode"

function storedMode(): DeckSyncMode {
  try {
    return localStorage.getItem(modePreference) === "follow" ? "follow" : "one-shot"
  } catch {
    return "one-shot"
  }
}

export function useDeckSync({ decks, setSpeed }: {
  decks: DeckSyncPair
  setSpeed: (id: DeckId, speed: number) => boolean
}) {
  const [mode, updateMode] = useState(storedMode)
  const [link, updateLink] = useState<DeckFollowLink | null>(null)
  const modeRef = useRef(mode)
  const linkRef = useRef(link)

  const { track: trackA, bpm: bpmA, speed: speedA, loading: loadingA } = decks.A
  const { track: trackB, bpm: bpmB, speed: speedB, loading: loadingB } = decks.B
  const followUpdate = useMemo(() => link && getDeckFollowUpdate(link, {
    A: { track: trackA, bpm: bpmA, speed: speedA, loading: loadingA },
    B: { track: trackB, bpm: bpmB, speed: speedB, loading: loadingB },
  }), [link, trackA, bpmA, speedA, loadingA, trackB, bpmB, speedB, loadingB])

  const setLink = useCallback((next: DeckFollowLink | null) => {
    linkRef.current = next
    updateLink(next)
  }, [])

  function release(id?: DeckId) {
    const active = linkRef.current
    if (active && (id === undefined || active.follower === id)) setLink(null)
  }

  function setMode(next: DeckSyncMode) {
    modeRef.current = next
    updateMode(next)
    if (next === "one-shot") release()
  }

  function sync(id: DeckId, matchOnce: () => boolean): "matched" | "released" | "unavailable" {
    const active = linkRef.current
    if (active?.follower === id && active.trackA === trackA && active.trackB === trackB) {
      setLink(null)
      return "released"
    }
    if (!matchOnce()) return "unavailable"
    if (modeRef.current === "follow") setLink(makeDeckFollow(id, decks))
    return "matched"
  }

  const applySpeed = useEffectEvent(setSpeed)
  useLayoutEffect(() => {
    if (!link || linkRef.current !== link) return
    if (!followUpdate) setLink(null)
    else if (followUpdate.speed !== null) applySpeed(followUpdate.follower, followUpdate.speed)
  }, [link, followUpdate, setLink])

  useEffect(() => {
    try { localStorage.setItem(modePreference, mode) } catch { /* Preferences are optional. */ }
  }, [mode])

  return { mode, setMode, follower: followUpdate?.follower ?? null, sync, release,
    followIssue: followUpdate?.issue ?? null }
}
