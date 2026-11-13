import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./blocks/ToastStack";
import { inDesktop } from "./lib/platform";
import "./styles/app.css";

/** pywebview adds `window.pywebview.api` a moment after the page loads, then fires this event. */
function bridgeReady(): Promise<void> {
  if (window.pywebview?.api) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("pywebviewready", () => resolve(), { once: true }));
}

async function boot() {
  if (inDesktop) {
    await bridgeReady();
  } else {
    // Outside the desktop app (plain browser, screenshots, browser tests) the
    // backend is replaced by an in-memory mock with fake sample data.
    const { installMock } = await import("./lib/mock");
    await installMock();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </React.StrictMode>,
  );
}

boot();
