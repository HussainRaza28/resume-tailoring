/**
 * The extension's service worker: real keyboard and mouse input for Autofill.
 *
 * Some pages (Workday's date boxes, search lists and dropdowns) ignore input a
 * script fakes with dispatched events, because those events aren't trusted.
 * A content script can't send trusted input, but the extension can, through
 * Chrome's debugger API: Input.insertText, Input.dispatchKeyEvent and
 * Input.dispatchMouseEvent arrive exactly as a person's typing and clicks do.
 *
 * The debugger is attached to the one tab being filled, for one Autofill run,
 * and detached right after. While it's attached Chrome shows a banner saying
 * "Tailor Autofill started debugging this browser"; it goes away on detach.
 * Nothing else is read or sent: only these input commands.
 */

type Message =
  | { type: "trusted"; action: "attach" | "detach" }
  | { type: "trusted"; action: "insertText"; text: string }
  | { type: "trusted"; action: "key"; key: string; code: string; keyCode: number; text?: string; modifiers?: number }
  | { type: "trusted"; action: "click"; x: number; y: number };

const attached = new Set<number>();
// One command at a time per tab, in the order the content script sent them.
const queues = new Map<number, Promise<unknown>>();

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

function send(tabId: number, method: string, params: object): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function run(tabId: number, m: Message): Promise<unknown> {
  switch (m.action) {
    case "attach":
      if (!attached.has(tabId)) {
        await chrome.debugger.attach({ tabId }, "1.3");
        attached.add(tabId);
      }
      return true;
    case "detach":
      if (attached.has(tabId)) {
        attached.delete(tabId);
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
      }
      return true;
    case "insertText":
      return send(tabId, "Input.insertText", { text: m.text });
    case "key": {
      const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: m.modifiers ?? 0 };
      // keyDown with text types the character (keydown, keypress, input); rawKeyDown is a key that types nothing.
      await send(tabId, "Input.dispatchKeyEvent", { ...base, type: m.text ? "keyDown" : "rawKeyDown", text: m.text, unmodifiedText: m.text });
      return send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    }
    case "click": {
      const at = { x: m.x, y: m.y };
      await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
      await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 });
      return send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 });
    }
  }
}

chrome.runtime.onMessage.addListener((message: Message, sender, reply) => {
  if (message?.type !== "trusted") return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    reply({ ok: false, error: "no tab" });
    return false;
  }
  if (message.action !== "attach" && message.action !== "detach" && !attached.has(tabId)) {
    reply({ ok: false, error: "not attached" });
    return false;
  }
  const previous = queues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => run(tabId, message));
  queues.set(tabId, next);
  next.then(
    () => reply({ ok: true }),
    (e) => reply({ ok: false, error: String((e as Error)?.message ?? e) }),
  );
  return true;
});
