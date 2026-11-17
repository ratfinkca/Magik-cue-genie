import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { StudioErrorBoundary } from "./DiagnosticsPanel";
import { diagnosticError, installStudioDiagnostics, recordDiagnostic } from "./studioDiagnostics";
import "./styles.css";

installStudioDiagnostics(import.meta.env.MODE + " " + new URL(import.meta.url).pathname.split("/").at(-1));
createRoot(document.getElementById("root")!, {
  onCaughtError: error => recordDiagnostic("error", "react.render_failed", diagnosticError(error)),
  onUncaughtError: error => recordDiagnostic("error", "react.uncaught", diagnosticError(error)),
  onRecoverableError: error => recordDiagnostic("warn", "react.recovered", diagnosticError(error)),
}).render(
  <StrictMode><StudioErrorBoundary><App /></StudioErrorBoundary></StrictMode>,
);

if (import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}studio-sw.js`, { updateViaCache: "none" })
    .catch(error => recordDiagnostic("warn", "offline.worker_failed", diagnosticError(error)));
}
