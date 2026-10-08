# ADR-042: Diagrams Drawn By Merman

| Field         | Value                         |
| ------------- | ----------------------------- |
| **Status**    | `accepted`                    |
| **Type**      | `Type 1 (two-way door)`       |
| **Domain**    | Desktop, Renderer, Transcript |
| **Date**      | 2026-10-07                    |
| **Author(s)** | Claude (AI-assisted)          |
| **Reviewers** | Sawmon Abo                    |

---

## Context

A reply's `mermaid` fence is drawn as a picture in the transcript, colored from the screen's own tokens, drawn again when the theme or the text size changes, with its source one press away ([Plan-020](../plans/020-desktop-app-and-renderer.md)). Agents write these fences often, several sessions stream at once, and a session can hold many of them.

The first build drew them with `mermaid` 12.1.0 on the renderer's main thread. mermaid needs a page: in a worker it fails at once with `document is not defined`. mermaid 12 also made ELK its default layout for flowchart, class, state and ER diagrams, so with no `layout` set, every one of those diagrams was laid out by ELK, not only a diagram that asked for it.

Seven renderers were measured on Oct 7, 2026, inside the app's own Electron 44.5.1 on an Apple M1 Pro with 16 GB (macOS 27.0), one fresh renderer process per window, with the app's palette and diagram config. The corpus was eight diagrams (flowchart, sequence, class, state, ER, gantt, mindmap, a 60-node flowchart) and one invalid diagram. Warm draw times are the median of ten. Memory is the macOS footprint, the number Activity Monitor shows, after the corpus, 300 more draws and a garbage collection; a blank page measures 25 MB.

| Renderer | 60-node flowchart | Small flowchart | Main-thread stall | Memory kept | Invalid diagram |
| --- | --- | --- | --- | --- | --- |
| mermaid 12.1, ELK by default | 172.8 ms | 48.5 ms | up to 72 ms | 206 MB | refused |
| mermaid 12.1, dagre | 196.3 ms | 45.5 ms | up to 188 ms | 188 MB | refused |
| merman 0.8.0, dagre | 21.0 ms | 8.1 ms | none (in a worker) | 78 MB | refused |
| sebastian 0.9 | 75.5 ms | 13.2 ms | none (in a worker) | 74 MB | refused |
| selkie 0.3 | 112.2 ms | 3.7 ms | none (in a worker) | 55 MB | refused |
| mmdr (master, patched) | 394.2 ms | 89.1 ms | none (in a worker) | 58 MB | drawn |
| beautiful-mermaid 1.1.3 | 30.3 ms | 6.3 ms | breaks in a worker | 136 MB | drawn |

In a worker, closing it dropped merman's footprint from 93 MB to 55 MB, against 37 MB for an empty worker. merman's WebAssembly heap peaked at 7.1 MB and stayed flat across the 300 draws.

## Problem Statement

Which library draws a reply's diagrams so that drawing never stalls the screen, memory stays small and bounded however many sessions and diagrams are open, every Mermaid diagram type is drawn, and the picture looks like Mermaid's?

### Trigger

mermaid stalled the main thread by up to 188 ms on one diagram, where a frame at 120 Hz has 8.3 ms, and kept 188 to 206 MB. The person asked for one library ranked on speed and memory, features, and looks, and on Oct 7, 2026 chose merman.

## Decision

1. **merman draws every diagram.** `@mermanjs/web-render` 0.8.0 (MIT OR Apache-2.0, released Oct 6, 2026; a Rust implementation of Mermaid compiled to WebAssembly, tracking Mermaid 12.1.0) replaces `mermaid`, which leaves the app. Its published build is used as it is, ELK included, so there is one package.
2. **Dagre is the default layout; a diagram may ask for ELK.** The site config sets `layout: "dagre"`, and a diagram whose own front matter or `init` asks for `elk` gets ELK. The app never rewrites a diagram's source.
3. **One shared worker for the whole app.** One `SharedWorker`, loaded from the renderer's own `sidekicks-renderer://` scheme (standard and secure, so every window is the same origin), draws for every window and every session. It draws one diagram at a time, the one nearest a reading position first, and cancels a draw whose row has left the window, through merman's per-operation cancellation and deadlines. It stays running while any window is open; it is never closed when idle.
4. **Text is measured with the screen's fonts.** Label widths come from the worker's `OffscreenCanvas` `measureText` in the screen's own font, handed to merman as its host text measurer, so boxes fit their labels. merman's own deterministic measurer is the fallback for a request the host cannot measure.
5. **The picture is safe to copy.** The worker returns merman's resvg-safe SVG, which carries no HTML labels (`foreignObject`), so a mindmap copies as a picture like every other type.
6. **Finished pictures are bounded by the screen's picture share.** A drawn picture is kept under the pictures' share of the machine's memory (1/64, at most 256 MiB), let go with its row when nothing on screen draws it, and drawn again on return.
7. **Notices ship with it.** The compiled ELK is EPL-2.0 and the math fonts OFL-1.1; their notices from merman's `THIRD_PARTY_NOTICES.md` go into the app's third-party notices.

**Budget:** no diagram draws on the renderer's main thread; merman costs one worker of about 40 to 50 MB above a blank page for the whole app, the same with one session open as with twenty; a picture's memory is counted in the screen's picture share. The build confirms these with its own run.

### Thesis — Why This Option

merman is the only candidate that is fast, draws every type, and looks like Mermaid. It draws 5 to 9 times faster than mermaid, keeps about 110 MB less, and needs no page, so drawing leaves the main thread entirely. It declares every Mermaid 12.1 diagram family, reads the same site config and theme variables, and its dagre pictures are close to identical to mermaid's. It refuses the invalid diagram as mermaid does, so a broken fence shows its error and source. Zed draws the Mermaid blocks in its agent replies with merman (zed-industries/zed#57644).

The worker is shared because the design opens a session in a window of its own, and each Electron window is its own renderer process: a worker per window would hold one copy per window. WebAssembly memory can only grow, never shrink, so closing the worker is the only way to give it back; with the heap flat at about 7 MB, an idle close would save little and add restarts, so the worker stays.

## Alternatives Considered

### Option A: merman 0.8.0 in one shared worker (Chosen)

- **What:** the decision above.
- **Steel man:** fast, small, every type, Mermaid's look, off the main thread.
- **Weaknesses:** a larger download, one main author, low npm use so far; see Consequences.

### Option B: mermaid 12.1 with ELK by default (Rejected)

The first build. Its ELK pictures read best on dense diagrams, but it draws only on the main thread, stalls up to 72 ms, keeps 206 MB, and lays out every flowchart with ELK whether asked or not. Setting `layout: "elk"` explicitly broke mindmaps.

### Option C: mermaid 12.1 with dagre set (Rejected)

The runner-up: the reference implementation with every type, but main-thread only, a stall of up to 188 ms on the 60-node flowchart, and 188 MB kept.

### Option D: Other WebAssembly and JavaScript renderers (Rejected)

- **sebastian 0.9:** one contributor and no npm package; every picture embeds a font (230 to 712 KB each); mindmap and ER tables come out black under the app's theme.
- **selkie 0.3:** no commits since May 2; tangled layouts on the large flowchart and the state diagram; theme colors ignored.
- **mmdr:** no WebAssembly build, and its code panics as WebAssembly until patched; fails syntax agents write all the time (`->>+`, `<<interface>>`); draws an invalid diagram instead of refusing it.
- **beautiful-mermaid 1.1.3:** six diagram types, still ships elkjs, breaks in a worker, draws an invalid diagram.
- **`@mermaid-js/tiny` 12.1:** drops mindmap. **`@toeverything/mermaid-wasm`:** an older mmdr fork its own product enables only on phones. **mmdflux, merlion, Warp's crate:** one to three types. **D2 and Graphviz:** cannot read Mermaid.

## Reversibility Assessment

- **Reversal cost:** low. The fence is Mermaid text, and only the diagram block's worker calls the renderer.
- **Blast radius:** the diagram block and the shared worker.
- **Migration path:** swap the worker's renderer; the block, its source view and the copy keep their shape.
- **Point of no return:** none.

## Consequences

### Positive

- No diagram stalls scrolling or streaming; a 60-node flowchart draws in about 21 ms off the main thread.
- One worker for every window and session, about 40 to 50 MB in all.
- Every Mermaid 12.1 type, with ELK when a diagram asks for it.

### Negative (accepted trade-offs)

- The WebAssembly file is 11.2 MB raw (3.2 MB brotli) against 5.2 MB for mermaid's JavaScript.
- One author wrote nearly all of merman, and `@mermanjs/web-render` had 214 npm downloads in the week to Oct 4, 2026 against about 20 million for `mermaid`; its main user is Zed through the Rust crate.
- Pictures are close to mermaid's, not pixel-identical; merman states it does not promise identical browser pixels.
- WebAssembly memory only grows, so the worker keeps its peak heap, about 7 MB on the corpus, for as long as it runs.
- ELK's EPL-2.0 and the math fonts' OFL-1.1 notices must ship with the app.

### Unknowns

- The diagram types new in Mermaid 12 (Agentflow, still beta syntax, and Usecase among them) were not drawn in the app; the build draws every type merman declares.
- In Chromium a shared worker runs in a renderer process of the windows using it. The build proves that closing the window that started it, while another window still draws diagrams, leaves drawing working.
- Whether `OffscreenCanvas` measurement in the worker matches the page's own measurement; the build compares the two on the corpus.

## Decision Validation

### Success Criteria

- Every corpus diagram and every type merman declares draws in the app, and the invalid diagram shows its error and source.
- No main-thread task over 8.3 ms comes from drawing a diagram while scrolling a reply full of diagrams.
- Three windows open with diagrams on screen run one merman worker, and closing the first window leaves the others drawing.
- A flowchart without `layout` lays out with dagre, and one asking for `elk` with ELK.
- A mindmap copies as a picture.

## References

### Research Conducted

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| merman README | Docs | A headless Rust implementation of Mermaid; Cargo features with and without ELK; a host text measurer for products that can measure; resvg-safe output for consumers that cannot draw `foreignObject`; no promise of identical browser pixels | <https://github.com/Latias94/merman> |
| merman CHANGELOG, 0.8.0 | Release notes | 0.8.0 (Oct 6, 2026) targets Mermaid 12.1.0; flowchart, state, class and ER default to ELK when compiled, and an explicit top-level `layout` keeps dagre; ELK is the EPL-2.0 `merman-elk-layered`; per-operation cancellation and deadlines | <https://github.com/Latias94/merman/blob/main/CHANGELOG.md> |
| merman on docs.rs | Docs | The crate's API and package family | <https://docs.rs/crate/merman/latest> |
| `@mermanjs/web-render` registry record | Registry | 0.8.0, MIT OR Apache-2.0, "Complete browser SVG renderer with Cytoscape, ELK, and math" | <https://registry.npmjs.org/@mermanjs/web-render> |
| zed-industries/zed#57644 | Pull request | Zed replaced its Mermaid renderer with merman (merged May 27, 2026), with ELK off and its own CSS clean-up passes | <https://github.com/zed-industries/zed/pull/57644> |
| Zed 1.5.0 release notes | Release notes | "Improved Mermaid diagram rendering speed and accuracy" | <https://zed.dev/releases/preview/1.5.0> |
| WebAssembly design #1397 | Issue | WebAssembly memory can grow but not shrink, and cannot hand pages back to the host | <https://github.com/WebAssembly/design/issues/1397> |
| WebAssembly design #1427 | Issue | Shrinking memory; re-creating the instance as the only way to reclaim it | <https://github.com/WebAssembly/design/issues/1427> |
| memory-control proposal, `memory.discard` | Proposal | Zeroes pages and lets the host release them; Phase 1, prototyped only in SpiderMonkey | <https://github.com/WebAssembly/memory-control/blob/main/proposals/memory-control/discard.md> |
| WebKit bug 269937 | Issue | WebAssembly memory cannot shrink | <https://www2.webkit.org/show_bug.cgi?id=269937> |
| MDN, `SharedWorker` | Docs | One worker reachable from several same-origin windows, alive while any of them holds it | <https://developer.mozilla.org/docs/Web/API/SharedWorker> |
| Electron `protocol` | Docs | A scheme registered as standard and secure resolves like `https`, giving the app's windows one origin | <https://electronjs.org/docs/latest/api/protocol> |
| reactant, multiple windows | Article | A shared worker as the one owner behind several windows | <https://reactant.js.org/blog/2021/10/03/how-to-make-web-application-support-multiple-browser-windows> |
| `mermaid` weekly downloads | Registry | About 20 million in the week to Oct 4, 2026 | <https://api.npmjs.org/downloads/point/last-week/mermaid> |

### Related ADRs

- [ADR-040](./040-drag-is-our-own-on-pointer-events.md): a session view tears off into its own window, which is why the worker is shared.
