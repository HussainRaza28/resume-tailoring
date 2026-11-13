/** Inline error and notice states, each with one clear next action. */
import type { ReactNode } from "react";
import type { CmdError } from "../lib/ipc";

export type NextAction = { label: string; run: () => void };

export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "error" | "warning";
  title: string;
  children?: ReactNode;
  action?: NextAction;
}) {
  return (
    <div className="notice enter" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
      <div className="notice-body">
        <span className="notice-title">{title}</span>
        {children && <span className="muted">{children}</span>}
      </div>
      {action && (
        <button className="btn btn-sm" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Plain-language title and the next action for each backend error kind. */
export function explainError(e: CmdError): { title: string; body: string; action: "settings" | "retry" | "import" | "trim" | null } {
  switch (e.kind) {
    case "bad_key":
      return { title: "The API key was rejected", body: "Check the key in Settings. It may have been revoked or pasted with a typo.", action: "settings" };
    case "missing_key":
      return { title: "No API key saved", body: "Add a key for this provider in Settings, or switch to another provider.", action: "settings" };
    case "rate_limited":
      return { title: "Rate limited", body: "The provider asked to slow down. Wait a few seconds and try again.", action: "retry" };
    case "offline":
      return { title: "You look offline", body: "The provider could not be reached. Check your connection, or switch to Ollama to work offline.", action: "retry" };
    case "server":
      return { title: "The provider had a problem", body: "It is overloaded or returned a server error. Trying again usually works.", action: "retry" };
    case "bad_output":
      return { title: "The reply was not in the expected format", body: e.message, action: "retry" };
    case "tectonic_missing":
      return { title: "Tectonic is not installed", body: "The PDF compiler is missing. Set its path or download it in Settings.", action: "settings" };
    case "tectonic_failed":
      return { title: "The PDF did not compile", body: e.message, action: "retry" };
    case "too_long":
      return { title: "The PDF runs over one page", body: e.message, action: "trim" };
    case "no_base_resume":
      return { title: "No base resume yet", body: "Choose your resume .tex file to start.", action: "import" };
    case "missing_provider":
      return { title: "This provider is not set up", body: e.message, action: "settings" };
    default:
      return { title: "Something went wrong", body: e.message, action: "retry" };
  }
}
