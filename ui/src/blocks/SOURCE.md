# Interface blocks from bencho.dev

The blocks below come from [bencho.dev](https://bencho.dev). Bencho's blocks are MIT licensed (bencho.dev/licence).

A block marked **original** is Bencho's own source, with its comments kept as written. A block marked **rebuilt** was written for this app from the block's public listing on bencho.dev, and is swapped for the original when its source is available.

| Block | Source | License | Used for | File | Status |
| --- | --- | --- | --- | --- | --- |
| ASCII wake | bencho.dev | MIT | Empty state before a posting is pasted | `AsciiWake.tsx` | original, with a new shape |
| ASCII wake, loader | bencho.dev | MIT | Animation while a step runs (a self-driven variant of ASCII wake) | `AsciiWakeLoader.tsx` | rebuilt |
| Upload dropzone | bencho.dev | MIT | Facts import: drop a PDF, Word, text or Markdown file | `UploadDropzone.tsx` | original, with additions |
| Collapsing sidebar | bencho.dev | MIT | History and navigation sidebar | `CollapsingSidebar.tsx` | rebuilt |
| Split view | bencho.dev | MIT | Steps on the left, PDF preview on the right | `SplitView.tsx` | rebuilt |
| Resizable panels | bencho.dev | MIT | The draggable divider of the split view | `SplitView.tsx` | rebuilt |
| Arc ring | bencho.dev | MIT | Match score gauge, before and after | `ArcRing.tsx` | rebuilt |
| Command bar | bencho.dev | MIT | Cmd/Ctrl+K palette | `CommandBar.tsx` | rebuilt |
| Toast stack | bencho.dev | MIT | Notifications | `ToastStack.tsx` | rebuilt |
| Dropdown | bencho.dev | MIT | Provider and model menu | `Menu.tsx` | rebuilt |
| Dot loader | bencho.dev | MIT | Small inline busy states | `Loaders.tsx` | rebuilt |
| Jelly tabs | bencho.dev | MIT | The step tabs' sliding thumb | `../components/Stepper.tsx` | rebuilt |

Bencho's design tokens (`--ink`, `--fill-on`, `--fill-slab`, `--font-ui` and so on) are mapped to the app's own tokens in `src/styles/tokens.css`. A token with no match is defined on the block's own root element, so nothing new becomes global.

The Upload dropzone is Bencho's demo block with its code and comments as written, plus a real-file mode added for the facts import. The additions are marked `app:` in the file. Without the `onFile` prop the block behaves as Bencho wrote it.

The ASCII wake draws a landscape page in place of Bencho's cube, on a wider block (520 by 240 instead of 360 by 240), in the theme's secondary text colour so it stays in the background. Bencho's `cube` function and every comment are kept as written. The changes are marked `app:` in the file.
