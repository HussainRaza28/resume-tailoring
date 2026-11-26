/**
 * How Autofill types and clicks.
 *
 * Trusted: real input through the extension's service worker and Chrome's
 * debugger API (background.ts). A click is a real mouse press at the
 * element's centre, text arrives as Input.insertText, keys as real key
 * presses. Pages see exactly what a person's typing produces, events marked
 * isTrusted included.
 *
 * Synthetic: dispatched events, as before, for when the debugger can't be
 * attached (the person declined, or the page is in a frame inside another
 * page, where a click position can't be worked out).
 *
 * Each run starts with `startTrusted()` and ends with `stopTrusted()`, which
 * detaches the debugger again.
 */

export type Mode = "trusted" | "synthetic";

let mode: Mode = "synthetic";
let why = "";

/** How the current run types: "trusted" or "synthetic", and why it's synthetic. */
export function inputMode(): { mode: Mode; reason: string } {
  return { mode, reason: why };
}

async function send(message: object): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await chrome.runtime.sendMessage({ type: "trusted", ...message })) ?? { ok: false, error: "no answer" };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Try to attach the debugger for real input. False (and synthetic input) when it can't be. */
export async function startTrusted(): Promise<boolean> {
  mode = "synthetic";
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    why = "no extension runtime";
    return false;
  }
  if (window.top !== window) {
    why = "page is inside a frame";
    return false;
  }
  const answer = await send({ action: "attach" });
  if (!answer.ok) {
    why = answer.error ?? "attach failed";
    return false;
  }
  mode = "trusted";
  why = "";
  return true;
}

export async function stopTrusted(): Promise<void> {
  if (mode === "trusted") await send({ action: "detach" });
  mode = "synthetic";
}

/** Use synthetic input for this run (tests, or a setting). */
export function useSynthetic(reason: string): void {
  mode = "synthetic";
  why = reason;
}

const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

// ---------------------------------------------------------------------------
// Synthetic events
// ---------------------------------------------------------------------------

function keyCodeOf(k: string): number {
  if (/^\d$/.test(k)) return 48 + Number(k);
  const named: Record<string, number> = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowDown: 40, ArrowUp: 38, Delete: 46, " ": 32 };
  return named[k] ?? k.toUpperCase().charCodeAt(0);
}

function codeOf(k: string): string {
  if (/^\d$/.test(k)) return `Digit${k}`;
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (k === " ") return "Space";
  return k.length === 1 ? "" : k;
}

function fakeKey(el: HTMLElement, type: "keydown" | "keypress" | "keyup", k: string): boolean {
  const keyCode = keyCodeOf(k);
  return el.dispatchEvent(new KeyboardEvent(type, { key: k, code: codeOf(k), keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }));
}

function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fakeType(el: HTMLInputElement | HTMLTextAreaElement, text: string, perKey: boolean): void {
  if (!perKey) {
    setNative(el, el.value + text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" }));
    return;
  }
  for (const ch of text) {
    const allowed = fakeKey(el, "keydown", ch);
    fakeKey(el, "keypress", ch);
    if (allowed) {
      setNative(el, el.value + ch);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" }));
    }
    fakeKey(el, "keyup", ch);
  }
}

function fakeClick(el: HTMLElement): void {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const Ctor = type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
  }
  el.click();
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

/** Click an element: a real mouse press at its centre, or dispatched mouse events. */
export async function click(el: HTMLElement): Promise<void> {
  if (mode === "trusted") {
    // A real click lands on whatever is at that point. A page that's still redrawing (Workday after a
    // ticked box) can move things between measuring and clicking, so the point is checked first:
    // it must hit the element or something inside it. A few tries, then dispatched events.
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = el.isConnected ? el : null;
      if (!now) break;
      now.scrollIntoView({ block: "center", inline: "nearest" });
      await frame();
      const r = now.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = r.width > 0 && r.height > 0 ? now.ownerDocument.elementFromPoint(x, y) : null;
      if (hit && (hit === now || now.contains(hit))) {
        const answer = await send({ action: "click", x, y });
        if (answer.ok) return;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  fakeClick(el);
}

/** Put focus in a field the way a click would. */
export async function focusField(el: HTMLElement): Promise<void> {
  if (el.ownerDocument.activeElement === el) return;
  await click(el);
  if (el.ownerDocument.activeElement !== el) el.focus();
}

/**
 * Type text into the focused field. Trusted: Input.insertText (one input
 * event, as a paste or an IME does) or, with ``perKey``, one real key press
 * per character (what Workday's date boxes listen for).
 */
export async function typeText(el: HTMLInputElement | HTMLTextAreaElement, text: string, perKey = false): Promise<void> {
  if (mode === "trusted") {
    if (perKey) {
      for (const ch of text) {
        const r = await send({ action: "key", key: ch, code: codeOf(ch), keyCode: keyCodeOf(ch), text: ch });
        if (!r.ok) return fakeType(el, text, true);
      }
      return;
    }
    const r = await send({ action: "insertText", text });
    if (r.ok) return;
  }
  fakeType(el, text, perKey);
}

/** Press a key that types nothing: Enter, Escape, Tab, Backspace, ArrowDown. */
export async function press(el: HTMLElement, key: string): Promise<void> {
  if (mode === "trusted") {
    const r = await send({ action: "key", key, code: codeOf(key), keyCode: keyCodeOf(key), text: key === "Enter" ? "\r" : undefined });
    if (r.ok) return;
  }
  fakeKey(el, "keydown", key);
  fakeKey(el, "keyup", key);
}

/** Empty a focused text field: select everything, then delete it. */
export async function clearField(el: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  if (!el.value) return;
  try {
    el.select();
  } catch {
    // A spinbutton or other input that can't be selected: delete character by character below.
  }
  if (mode === "trusted") {
    const selectedAll = el.selectionStart === 0 && el.selectionEnd === el.value.length;
    const times = selectedAll ? 1 : el.value.length;
    for (let i = 0; i < times; i++) await press(el, "Backspace");
    if (!el.value) return;
  }
  fakeKey(el, "keydown", "Backspace");
  setNative(el, "");
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
  fakeKey(el, "keyup", "Backspace");
}

/** Leave a field, as clicking elsewhere would: Workday commits many fields on blur. */
export function leave(el: HTMLElement): void {
  if (el.ownerDocument.activeElement === el) el.blur();
  else {
    el.dispatchEvent(new FocusEvent("blur"));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }
}

/** Whether focus is still in ``el`` (Workday moves it when it redraws a field). */
export function hasFocus(el: HTMLElement): boolean {
  return el.ownerDocument.activeElement === el;
}
