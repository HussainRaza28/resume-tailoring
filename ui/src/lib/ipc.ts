/**
 * How the interface talks to the Python backend.
 *
 * In the desktop app, pywebview puts the Python bridge on `window.pywebview.api`.
 * It has one method, `call(command, args)`, which runs the named command and
 * answers `{ ok: value }` or `{ error: { kind, message } }`.
 *
 * Streaming steps pass a channel id. Python pushes events for that id back into
 * the page by calling `window.__tailorEmit(id, event)`.
 *
 * In a plain browser (screenshots, Playwright) a mock backend is installed in
 * place of the bridge, with fake sample data.
 */

export interface CmdError {
  kind: string;
  message: string;
}

export function isCmdError(e: unknown): e is CmdError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

type Reply = { ok: unknown } | { error: CmdError };
type Backend = (command: string, args: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    pywebview?: { api: { call: (command: string, args: Record<string, unknown>) => Promise<Reply> } };
    __tailorEmit?: (channel: string, event: unknown) => void;
  }
}

let mockBackend: Backend | null = null;

/** Use an in-memory backend instead of the Python bridge (browser mode only). */
export function installMockBackend(backend: Backend) {
  mockBackend = backend;
}

/** Run a backend command. Errors are always thrown as `CmdError`. */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    if (mockBackend) return (await mockBackend(command, args)) as T;
    const api = window.pywebview?.api;
    if (!api) throw { kind: "no_backend", message: "The app's backend is not connected." } satisfies CmdError;
    const reply = await api.call(command, args);
    if ("error" in reply) throw reply.error;
    return reply.ok as T;
  } catch (e) {
    if (isCmdError(e)) throw e;
    throw { kind: "unknown", message: String(e) } satisfies CmdError;
  }
}

// ---------------------------------------------------------------------------
// Event channels for streaming steps
// ---------------------------------------------------------------------------

const listeners = new Map<string, (event: unknown) => void>();
let nextChannel = 1;

window.__tailorEmit = (channel, event) => listeners.get(channel)?.(event);

/** Open a channel for one call's streamed events. Close it when the call is done. */
export function openChannel<E>(onEvent?: (event: E) => void): { id: string; close: () => void } {
  const id = `ch${nextChannel++}`;
  if (onEvent) listeners.set(id, onEvent as (event: unknown) => void);
  return { id, close: () => listeners.delete(id) };
}

/** Send an event to a channel. The mock backend uses this; Python calls `__tailorEmit` directly. */
export function emit(channel: unknown, event: unknown) {
  if (typeof channel === "string") listeners.get(channel)?.(event);
}

/** PDF bytes arrive base64-encoded. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
