const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

export const LOCAL_BACKEND_REQUIRED = "Run Cue Studio locally to use Python analysis and stem separation."

export function localBackendUrl(relativeRoute: string): URL | null {
  if (import.meta.env?.VITE_STUDIO_STATIC === "1" || typeof document === "undefined") return null
  const target = new URL(relativeRoute, document.baseURI)
  const page = new URL(document.URL ?? document.baseURI)
  if (target.origin !== page.origin || !loopbackHosts.has(target.hostname)
    || (target.protocol !== "http:" && target.protocol !== "https:")) return null
  return target
}

export function studioLocalBackendAvailable(): boolean {
  return localBackendUrl("api/") !== null
}
