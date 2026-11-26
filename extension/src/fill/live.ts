/**
 * Workday replaces a field's element when it redraws a section: after a
 * dropdown is chosen, a box ticked or an entry added. A value typed into the
 * old element goes nowhere, and reading it back from the old element says it
 * worked. So every step finds its element again first.
 *
 * An element is found again by its id (Workday's ids, such as
 * phoneNumber--phoneNumber, stay the same across redraws), or by its path of
 * child positions from the nearest ancestor that has an id.
 */

const finders = new WeakMap<Element, () => Element | null>();

function pathFrom(el: Element): { anchor: string | null; steps: number[] } {
  const steps: number[] = [];
  let node: Element = el;
  while (!node.id && node.parentElement) {
    steps.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    node = node.parentElement;
  }
  return { anchor: node.id || null, steps };
}

/** Remember how to find ``el`` again. Called when a field is first seen. */
export function remember(el: Element): void {
  if (finders.has(el)) return;
  const doc = el.ownerDocument;
  if (el.id) {
    const id = el.id;
    finders.set(el, () => doc.getElementById(id));
    return;
  }
  const { anchor, steps } = pathFrom(el);
  const tag = el.tagName;
  finders.set(el, () => {
    let node: Element | null = anchor ? doc.getElementById(anchor) : doc.body;
    for (const i of steps) node = node?.children[i] ?? null;
    return node && node.tagName === tag ? node : null;
  });
}

/** The element as it is on the page now: ``el`` itself while it's attached, else its replacement. */
export function live<T extends Element>(el: T): T {
  if (el.isConnected) return el;
  // A path can only be worked out while the element is on the page; once it's gone, only its id is left.
  const id = el.id;
  const finder = finders.get(el) ?? (id ? () => el.ownerDocument.getElementById(id) : undefined);
  const found = finder?.();
  if (found && found !== el) {
    // The replacement can be found the same way next time.
    if (finder) finders.set(found, finder);
    return found as T;
  }
  return el;
}

/** Whether ``el`` was replaced since it was remembered. */
export function replaced(el: Element): boolean {
  return !el.isConnected && live(el) !== el;
}
