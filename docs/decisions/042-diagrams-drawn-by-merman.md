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

A reply's `mermaid` fence is drawn as a picture in the transcript, colored from the screen's own tokens, drawn again when the theme or the text size changes, with its source one press away ([Plan-020](../plans/020-desktop-app-and-renderer.md)). Agents write these fences often, several sessions stream at once, and a session can hold many of them. One renderer drives every window of the app: every window a person sees is a `window.open` child of one hidden console document ([Spec-021 §Process Model](../specs/021-desktop-app-and-renderer.md#process-model)).

`mermaid` 12.1 draws only with a page: in a worker it fails at once with `document is not defined`, so every draw runs on the renderer's main thread. mermaid 12 also makes ELK its default layout where ELK is installed, so a diagram that sets no `layout` is laid out by ELK too.

Seven renderers were measured on Oct 7, 2026, inside the app's own Electron 44.5.1 on an Apple M1 Pro with 16 GB (macOS 27.0), each in a fresh renderer process, with the app's palette and diagram config. The corpus was eight diagrams (flowchart, sequence, class, state, ER, gantt, mindmap, a 60-node flowchart) and one invalid diagram. Warm draw times are the median of ten. Memory is the macOS footprint, the number Activity Monitor shows, after the corpus, 300 more draws and a garbage collection; a blank page measures 25 MB.

| Renderer | 60-node flowchart | Small flowchart | Main-thread stall | Memory kept | Invalid diagram |
| --- | --- | --- | --- | --- | --- |
| mermaid 12.1, ELK by default | 172.8 ms | 48.5 ms | up to 72 ms | 206 MB | refused |
| mermaid 12.1, dagre | 196.3 ms | 45.5 ms | up to 188 ms | 188 MB | refused |
| merman 0.8.0, dagre | 21.0 ms | 8.1 ms | none (in a worker) | 78 MB | refused |
| merman 0.8.0, dagre, resvg-safe output | 38.6 ms | 13.2 ms | none (in a worker) | — | refused |
| sebastian 0.8.0 | 75.5 ms | 13.2 ms | none (in a worker) | 74 MB | refused |
| selkie 0.3 | 112.2 ms | 3.7 ms | none (in a worker) | 55 MB | refused |
| mmdr (master, patched) | 394.2 ms | 89.1 ms | none (in a worker) | 58 MB | drawn |
| beautiful-mermaid 1.1.3 | 30.3 ms | 6.3 ms | breaks in a worker | 136 MB | drawn |

In a worker, after 100 draws and a garbage collection, merman's footprint was 93 MB against 37 MB for an empty worker, and ending the worker dropped it to 55 MB. merman's WebAssembly heap peaked at 7.1 MB and stayed flat across the 300 draws. Measuring labels with the page's own fonts made merman's draws 1.5 to 2 times slower.

## Problem Statement

Which library draws a reply's diagrams so that drawing never stalls the screen, memory stays small and bounded however many sessions and diagrams are open, every Mermaid diagram type is drawn, and the picture looks like Mermaid's?

### Trigger

mermaid stalled the main thread by up to 188 ms on one diagram, where a frame at 120 Hz has 8.3 ms, and kept 188 to 206 MB. On Oct 7, 2026 the person chose merman, with ELK kept in.

## Decision

1. **merman draws every diagram.** `@mermanjs/web-render` 0.8.0 (MIT OR Apache-2.0, released Oct 6, 2026; a Rust implementation of Mermaid compiled to WebAssembly, tracking Mermaid 12.1.0) replaces `mermaid`, which leaves the app. Its published build is used as it is, ELK included, so there is one package; [ADR-019 §License](./019-v1-deployment-model-and-oss-license.md#license) waives ELK's EPL-2.0 and the math fonts' OFL-1.1.
2. **Dagre is the default layout; a diagram may ask for ELK.** The site config sets `layout: "dagre"`, and a diagram whose own front matter or `init` asks for `elk` gets ELK. The app adds nothing to a diagram's source; the only change it makes is the cleaning [Desktop App Implementation Notes §Console Libraries](../architecture/desktop-implementation-notes.md#console-libraries) lists (invisible characters, line endings, entities, smart quotes).
3. **One worker for the whole app.** The hidden console document starts one dedicated worker, which draws for every window and every session. It draws one diagram at a time, the one nearest a reading position first. A queued draw whose row has left the window is dropped, and a result that arrives after its row has gone is discarded. Each draw carries merman's `timeout_ms` deadline, within merman's `interactive` layout-work allowance. After an initialization failure, or a draw that leaves the instance failed, the worker is ended and a new one started, as merman's web guide directs; it is never ended for being idle.
4. **Text is measured with the screen's fonts.** The worker loads the IBM Plex faces through `FontFace` and `self.fonts`, and the app's own host text measurer, on `OffscreenCanvas` `measureText`, gives merman each label's width, so boxes fit their labels. merman's deterministic measurer is the fallback for a request the host cannot measure.
5. **Fast output on screen, copy-safe output on copy.** A diagram is shown as an `<img>` of merman's default SVG. Copy as picture asks the worker for that diagram's resvg-safe SVG at the moment of the copy, because HTML labels (`foreignObject`) in the default output would taint the canvas the copy draws on.
6. **Strict and inert.** merman runs at its strict `securityLevel` (labels and tooltips sanitized, unsafe URL schemes blocked, no script or click hook). merman's default `secure` list filters `securityLevel` out of a diagram's own front matter and `init`, so a diagram cannot loosen it. Shown through `<img>`, a picture runs no script and loads nothing from outside, so a link in a diagram is drawn but goes nowhere.
7. **Pictures are bounded by the screen's picture share.** The drawn SVG is cached least-recently-used under the pictures' share of the machine's memory (1/64, at most 256 MiB), keyed as the notes row describes. Its decoded picture is let go once nothing on screen draws it and decoded again on return.
8. **The renderer's content security policy allows WebAssembly.** `script-src` gains `'wasm-unsafe-eval'` ([Spec-021 §Security Hardening Baseline](../specs/021-desktop-app-and-renderer.md#security-hardening-baseline)), which lets WebAssembly compile and allows no JavaScript evaluation.
9. **Notices ship with it.** The packaged app's third-party notices reproduce merman's `THIRD_PARTY_NOTICES.md` and say where ELK's source is available, as ADR-019's waiver requires.

**Budget:** no diagram draws on the renderer's main thread; merman costs one worker of about 40 MB for the whole app (ending it took 93 MB down to 55 MB), the same with one session open as with twenty; a picture's memory is counted in the screen's picture share. The build confirms these with its own run.

**The build proves:** every corpus diagram and every type merman declares draws in the app, and the invalid diagram shows its error and source; scrolling a reply full of diagrams shows no main-thread task over 8.3 ms from drawing; two windows with diagrams on screen run one worker; a flowchart with no `layout` lays out with dagre and one asking for `elk` with ELK; a diagram whose front matter sets `securityLevel: loose` still draws strict; a mindmap copies as a picture.

### Thesis — Why This Option

merman is the only candidate that is fast, draws every type, and looks like Mermaid. Its default output draws the 60-node flowchart 8 to 9 times faster than mermaid and the corpus 5 to 9 times faster, and the page keeps about 110 MB less; it needs no page, so drawing leaves the main thread entirely. It declares every Mermaid 12.1 diagram family, reads the same site config and theme variables, and its dagre pictures are close to identical to mermaid's. It refuses the invalid diagram as mermaid does, so a broken fence shows its error and source. Zed draws the Mermaid blocks in its Markdown with merman.

One dedicated worker is enough because one renderer drives every window. It stays running because WebAssembly memory can grow but never shrink, so only ending the worker gives it back, and merman's heap stays flat at about 7 MB: an idle end would save about 40 MB at the cost of a restart before the next diagram. The part that is never reclaimed is bounded by the largest diagram drawn, not by how many.

## Alternatives Considered

### Option A: merman 0.8.0 in one worker (Chosen)

- **What:** the decision above.
- **Steel man:** fast, small, every type, Mermaid's look, off the main thread.
- **Weaknesses:** a larger download, one main author, low npm use so far; see Consequences.

### Option B: mermaid 12.1 with ELK by default (Rejected)

- **What:** mermaid 12.1 with no `layout` set, so ELK lays out flowchart, class, state and ER diagrams.
- **Why rejected:** main thread only, a stall of up to 72 ms and 206 MB kept; setting `layout: "elk"` explicitly broke mindmaps.

### Option C: mermaid 12.1 with dagre set (Rejected)

- **What:** the reference implementation with `layout: "dagre"`.
- **Why rejected:** main thread only, a stall of up to 188 ms on the 60-node flowchart, and 188 MB kept.

### Option D: Drawing in the daemon (Rejected)

- **What:** merman's Node.js package in the daemon, as [ADR-033](./033-one-syntax-colorer-in-the-daemon.md) colors code there.
- **Why rejected:** that package is experimental and covers deterministic SVG and layout, not merman's full capability set; the daemon cannot measure labels in the screen's fonts; the theme lives in the renderer; and every draw would cross the connection both ways.

### Option E: Other WebAssembly and JavaScript renderers (Rejected)

- **What:** sebastian 0.8.0, selkie 0.3, mmdr, beautiful-mermaid 1.1.3, `@mermaid-js/tiny` 12.1, `@toeverything/mermaid-wasm`, mmdflux, merlion, Warp's `mermaid-to-svg`, D2 and Graphviz.
- **Why rejected:**
  - sebastian has one contributor and no npm package, embeds a font in every picture (230 to 712 KB each), and draws mindmap and ER tables black under the app's theme.
  - selkie has had no commits since May 2, tangles the large flowchart and the state diagram, and ignores theme colors.
  - mmdr has no WebAssembly build and panics as WebAssembly until patched, fails syntax agents write all the time (`->>+`, `<<interface>>`), and draws an invalid diagram instead of refusing it.
  - beautiful-mermaid draws six types, still ships elkjs, breaks in a worker and draws an invalid diagram.
  - `@mermaid-js/tiny` drops mindmap; `@toeverything/mermaid-wasm` is an older mmdr fork its own product enables only on phones; mmdflux and merlion cover one to three types; Warp's crate draws only flowcharts at parity; D2 and Graphviz cannot read Mermaid.

## Reversibility Assessment

- **Reversal cost:** low. The fence is Mermaid text, and only the diagram worker calls the renderer.
- **Blast radius:** the diagram block and its worker.
- **Migration path:** swap the worker's renderer; the block, its source view and the copy keep their shape.
- **Point of no return:** none.

## Consequences

### Positive

- No diagram stalls scrolling or streaming; a 60-node flowchart draws in about 21 ms off the main thread.
- One worker for every window and session, about 40 MB in all.
- Every Mermaid 12.1 type, with ELK when a diagram asks for it.

### Negative (accepted trade-offs)

- The WebAssembly file is 11.2 MB raw (3.2 MB brotli) against 5.2 MB for mermaid's JavaScript.
- One author wrote nearly all of merman, and `@mermanjs/web-render` had 214 npm downloads in the week to Oct 4, 2026 against about 20 million for `mermaid`; its main user is Zed, through the Rust crate.
- Pictures are close to mermaid's, not pixel-identical; merman does not promise identical browser pixels.
- A copy as picture costs one resvg-safe draw at copy time, 38.6 ms on the 60-node flowchart.
- A link inside a diagram goes nowhere.
- WebAssembly memory only grows, so the worker keeps its peak heap, about 7 MB on the corpus, for as long as it runs.
- The renderer's policy carries `'wasm-unsafe-eval'`, and ELK's EPL-2.0 and the math fonts' OFL-1.1 notices ship with the app.

### Unknowns

- The diagram types new in Mermaid 12, Agentflow (still beta syntax) and Usecase among them, were not drawn in the app; the build draws every type merman declares.
- Whether `OffscreenCanvas` measurement in the worker matches the page's own, and what it costs per draw; the build compares the two on the corpus.

## References

### Research Conducted

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| merman README | Docs | A headless Rust implementation of Mermaid; Cargo features with and without ELK; a host text measurer for products that can measure; resvg-safe output for consumers that cannot draw `foreignObject`; no promise of identical browser pixels | <https://github.com/Latias94/merman> |
| merman CHANGELOG, 0.8.0 | Release notes | 0.8.0 (Oct 6, 2026) targets Mermaid 12.1.0; Flowchart, State, Class, ER, Requirement, Usecase and Agentflow default to ELK when it is compiled, and an explicit top-level `layout` keeps dagre; ELK is the EPL-2.0 `merman-elk-layered`; the Node.js package covers deterministic SVG and layout, not the full capability set | <https://github.com/Latias94/merman/blob/main/CHANGELOG.md> |
| merman web packages guide | Docs | No mid-call abort: a transport-owned `timeout_ms` deadline checked between steps; a host that loads merman in a dedicated worker ends that worker after an initialization failure or a replacement | <https://github.com/Latias94/merman/blob/main/platforms/web/README.md> |
| merman config and front-matter support | Docs | merman's default site policy keeps Mermaid's `secure` list plus `themeCSS`; init directives cannot change `secure`, and protected keys such as `securityLevel` are filtered out of a diagram's own config | <https://github.com/Latias94/merman/blob/main/docs/alignment/CONFIG_FRONTMATTER_SUPPORT.md> |
| merman rendering security guide | Docs | Strict by default: sanitized labels and tooltips, unsafe URL schemes blocked, no `bindFunctions` hook, no network or file lookup for icons | <https://github.com/Latias94/merman/blob/main/docs/security/RENDERING_SECURITY.md> |
| `@mermanjs/web-render` registry record | Registry | 0.8.0, MIT OR Apache-2.0, "Complete browser SVG renderer with Cytoscape, ELK, and math" | <https://registry.npmjs.org/@mermanjs/web-render> |
| zed-industries/zed#57644 and Zed's `Cargo.toml` | Pull request | Zed replaced its Mermaid renderer with merman (merged May 27, 2026); it now depends on `merman` `=0.8.0-alpha.5` with default features off, so without ELK | <https://github.com/zed-industries/zed/pull/57644> |
| Zed 1.5.0 release notes | Release notes | "Improved Mermaid diagram rendering speed and accuracy" | <https://zed.dev/releases/preview/1.5.0> |
| WebAssembly design #1397 | Issue | WebAssembly memory can grow but not shrink, and cannot hand pages back to the host | <https://github.com/WebAssembly/design/issues/1397> |
| WebAssembly design #1427 | Issue | Shrinking memory; re-creating the instance as the way to reclaim it | <https://github.com/WebAssembly/design/issues/1427> |
| memory-control proposal, `memory.discard` | Proposal | Zeroes pages and lets the host release them; Phase 1, with a SpiderMonkey prototype | <https://github.com/WebAssembly/memory-control/blob/main/proposals/memory-control/discard.md> |
| MDN, content security policy | Docs | `'wasm-unsafe-eval'` lets WebAssembly compile and instantiate and permits no JavaScript `eval` or `new Function` | <https://developer.mozilla.org/en-us/add-ons/webextensions/manifest.json/content_security_policy> |
| MDN, SVG as an image | Docs | In an `<img>`, an SVG runs no script and loads no external resource | <https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image> |
| EPL-2.0 | License | §3.1: a program distributed other than as source must state that its source is available and how to obtain it | <https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt> |
| `mermaid` weekly downloads | Registry | About 20 million in the week to Oct 4, 2026 | <https://api.npmjs.org/downloads/point/last-week/mermaid> |

### Related ADRs

- [ADR-019](./019-v1-deployment-model-and-oss-license.md): the license norm and the waiver for ELK and the math fonts.
- [ADR-033](./033-one-syntax-colorer-in-the-daemon.md): code coloring in the daemon, the precedent Option D weighs.
- [ADR-040](./040-drag-is-our-own-on-pointer-events.md): every window a child of the one console document.
