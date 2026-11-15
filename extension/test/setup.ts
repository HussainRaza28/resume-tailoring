// jsdom lacks a few browser features the extension relies on. These stand-ins
// exist only in tests; Chrome has the real ones.

// DataTransfer, used to put a file into a file input.
if (typeof globalThis.DataTransfer === "undefined") {
  class FakeDataTransfer {
    private list: File[] = [];
    items = { add: (file: File) => this.list.push(file) };
    get files(): FileList {
      const files = [...this.list];
      return Object.assign(files, { item: (i: number) => files[i] ?? null }) as unknown as FileList;
    }
  }
  (globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer;
}

// jsdom only accepts its own FileList for input.files, so keep what was set.
const chosen = new WeakMap<HTMLInputElement, FileList>();
Object.defineProperty(HTMLInputElement.prototype, "files", {
  configurable: true,
  get(this: HTMLInputElement) {
    return chosen.get(this) ?? ([] as unknown as FileList);
  },
  set(this: HTMLInputElement, files: FileList) {
    chosen.set(this, files);
  },
});

// CSS.escape, used to look up <label for="...">.
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, "\\$1"),
  };
}

export {};
