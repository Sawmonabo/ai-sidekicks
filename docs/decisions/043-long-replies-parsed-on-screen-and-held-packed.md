# ADR-043: Long Replies Parsed On Screen And Held Packed

| Field         | Value                         |
| ------------- | ----------------------------- |
| **Status**    | `accepted`                    |
| **Type**      | `Type 1 (two-way door)`       |
| **Domain**    | Desktop, Renderer, Transcript |
| **Date**      | 2026-10-12                    |
| **Author(s)** | Claude (AI-assisted)          |
| **Reviewers** | Sawmon Abo                    |

---

## Context

A reply is markdown, drawn in the transcript as a window of blocks: a long reply mounts only the blocks near the reading position, and each block is drawn from its parsed tree. The parser is Sätteri 0.10.5 (`satteri` and `@bruits/satteri-wasm32-wasi`, both MIT), a Rust markdown parser built on its own fork of pulldown-cmark and shipped as a WebAssembly module of 3,089,353 bytes. It parses in the app's one markdown worker, which every window shares and which alone compiles the module ([Spec-021 §Security Hardening Baseline](../specs/021-desktop-app-and-renderer.md#security-hardening-baseline)); the worker hands each tree back as a transferred buffer. Sätteri's browser loader creates the parser's memory as shared memory of `initial: 4000` pages, a 250 MiB reservation of which only the `initial` pages are made writable, and its `asyncWorkPoolSize: 4` started no thread in any run. The app's two `pnpm` patches make that loader take the module the worker compiled instead of fetching its own, export Sätteri's tree reader and materializer as their own subpaths, and export its tree walk, `walkMdastHandle`, from its main entry ([BL-171](../backlog.md#bl-171-sätteris-browser-loader-taking-an-already-compiled-parser), [BL-172](../backlog.md#bl-172-sätteri-exporting-its-tree-reader-materializer-and-walk-on-their-own)).

A body is drawn only once every one of its blocks has a tree, so the worker parses every settled block of a body and the page keeps each tree, its buffer, a cache entry keyed by a copy of the block's text, and a record per block in each of the row's two block readers. A row cuts its body into blocks with a hand-written scan for blank lines, twice, once per reader.

The figures, measured on Oct 12, 2026 on an Apple M1 Pro (headless Chromium 156 for the page, Electron 44.7.0 for the policy, the codec and the cut):

| What | Figure |
| --- | --- |
| Renderer heap at rest with an 8 MiB prose reply, every tree kept | 223.7 MB, against 126.2 MB before trees were kept and the 120 MB `renderer-heap-at-rest` budget |
| Time for that reply to settle | 2,103 ms, against 386 ms before |
| The worker's footprint after parsing 99,231 blocks one message each | 15 MB blank, 317 MB after, 285 MB three seconds later (parser memory 324 MiB); the heap figures the budget reads count none of it |
| The page parsing a far jump's 32 blocks | 0.2–0.3 ms median, 0.9–3.1 ms p99, 4.0–4.3 ms worst (reading kept trees: 0.04–0.05 ms) |
| Starting the parser on the page from a compiled module | 18.1–23.3 ms once, first parse 8.5–9.0 ms; +3 MB footprint to start, +13 MB after 19,200 parses |
| One block of 33 K and 262 K characters on the page | 0.7 ms; 4.7–4.9 ms median, up to 15.4 ms |
| 8 MiB of text as a JavaScript string | 8.39 MB one-byte, 16.78 MB two-byte; one character above U+00FF makes the whole string two-byte, and a docs-like reply held 14,226 of them |
| A row's block records at 92,310 blocks | 11.7 MB per reader, two readers; the same records as typed arrays 2.51 MB in all |
| One reader's cut, fingerprint and record pass at 92,310 blocks | 121 ms |

A stored body is kept whole, however long, and stored as zstd frames of at most one page each from 1 KiB, so a body read decodes only the frames its part covers; a body over 32 KiB reaches the window as its size alone until it is opened (`TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`), and a streamed reply is stored as many rows; one multi-MiB body arrives with the planned live reply, and the 8 MiB bench reply stands in for it.

## Problem Statement

How does a long reply cost a small, fixed amount of window memory while drawing exactly as a whole-document parse draws it, never drawn before it is formatted, and never late or blank when a person scrolls or jumps to any part of it?

### Trigger

Keeping every block's tree put an 8 MiB reply at 223.7 MB against a 120 MB budget and slowed its settle from 386 to 2,103 ms, and the worker's parser memory grew by about 300 MB that no budget counted. On Oct 12, 2026 the person chose to parse on the page only what is mounted, keep one block reader per row with typed records, and hold the text as UTF-8 packed with lz4, with the parser deciding where every body is cut.

## Decision

1. **The page parses the blocks it mounts, with the worker's parser.** When the markdown worker posts its compiled parser, the page starts its own parser from that module in an idle task (`queueIdleTaskIn`, which carries a timeout, so it starts under load too), with a warm-up parse of the worker's warm-up text in the same task. The page sets the loader's global to the posted module and loads the loader on its own lazy chunk, never in the startup bundle; the loader's thread pool is built as a stub that throws, so it never starts a thread on the page. A block is parsed synchronously in the frame it mounts, against its definitions preamble, so its first frame is formatted; after each commit the body drops every page tree outside the committed blocks, so no tree is kept for a block that is not mounted. A block of more than 32,768 UTF-16 units, the size a long table is cut into pieces at, parses in the worker, as do a long table's pieces and the streaming tail; those trees are held while their body lives, so a far jump draws them on its first frame. Each is held as the worker's binary tree, keyed by a 64-bit hash of the block's preamble and text with no copy of either, and read into the drawn tree from the block's text cut again from the body's packed text. A block too long for the page has its binary tree packed with lz4 in an idle task once it is held, in chunks of at most 16 KiB like the text's, and unpacked only when the block is read, so what the body holds for them is those packed trees, plus the long table's piece cap: 1.57 MB for 8.41 MB of over-cap UTF-8 text in an 8 MiB reply of repetitive 48,000-character paragraphs (18.08 MB unpacked), and 1.4 to 1.7 times the UTF-8 size of over-cap paragraphs and lists of real prose, whose trees are 2.2 to 2.8 times it unpacked. No held tree has a bound of its own: the renderer's 120 MB at rest bounds them, and the cache of worker trees, 2 MiB, charges a held tree its packed bytes once it is packed, so the trees it keeps for other bodies are not evicted for bytes no longer held. A body's first draw waits until the page parser is ready, a wait bounded by the idle task's timeout plus the start. A page parser that fails to start sends every block of a body to the worker, with the memory that costs; a worker that fails later leaves a ready page parser in place.
2. **One block reader per row, with typed records.** The row's preparation owns the cut and publishes the one reader beside the body's text, and the drawn body reads it. Its records are typed arrays: block starts in UTF-16 units, an FNV-1a hash per block, a flag byte set once from the block's text (a fence; may define a footnote; may define a link; may open a deferred fence; holds a `$`; may hold a long table), and each line's length as 32 bits, from which every height estimate is computed without reading text. The block window keys blocks by number: block `i` of the current text is `i`, the streaming tail `-1`, and block `i` of a replaced text `-(i + 2)`, which keeps its own text and records until it leaves, so old and new blocks never share a key or a size.
3. **The definitions table holds footnotes and link definitions.** A block flagged as possibly defining one is parsed on the page and its `definition` and `footnoteDefinition` nodes read. Each definition is restated in every other block's preamble from the node's label, URL and title, never from its source, which inside a quote or list carries the container's markers; a label's first definition in document order wins, as in a whole-document parse. When a definition arrives, the mounted blocks parse again against the new preamble and every worker-held block is asked for again. A reference link whose definition sits in another block draws as a link.
4. **The parser cuts every body, live and saved: on the page for a short body, in the worker for the rest.** One function cuts a body into blocks with Sätteri itself, on either thread: the page cuts a text no longer than its parse cap once its parser is ready, in under a few milliseconds and with no round trip, so a row is listed without waiting on the worker; a longer text, or any text before the page's parser is ready, is cut in the worker. The function: parse windows of whole lines from the cut, 64 KiB to start; keep every top-level child but the last two and start the next window at the first child held back; double a window holding fewer than three children; start each block at its line's start. While streaming, the window is the mended tail, and no child ending past the common prefix of the tail and its mended text is frozen, since mending can rewrite as well as append. Once a body is whole, the same function runs over the rest with no mend, so the cut and the keys never change when the stored body takes over. The cut reads each window's root and children, never the serialized tree, and lets the worker's event loop turn between windows so the binding's finalizers free its buffers. It parses the text the worker draws, each NUL already replaced; the dollar stand-in a block's own parse may add is left out, since which dollars open a formula is read inside a block and moves no block's bounds, and the stand-in is one UTF-16 unit, so cut offsets and drawn trees index one string. No hand-written scan cuts a body.
5. **The text is held as packed UTF-8.** A body is encoded with `TextEncoder` where it is admitted to the window and its string let go. It is held in chunks of at most 16 KiB, each cut at a code-point boundary so it decodes alone, with a table of each chunk's UTF-16 start; a slice or a search finds its chunks by binary search and decodes only those, and the last four decoded chunks of any text are kept in one shared cache. A full chunk is packed with lz4 in an idle task, never on admission; a growing text's last chunk stays open, and a chunk whose packed form is not smaller stays plain. The live reply's chunked text and the escape-stripped text of a command's output are the same packed type.
6. **The codec is lz4_flex 0.14.0, safe build, loaded on first need.** `packages/compression` is a Rust crate built for `wasm32-unknown-unknown` with `lz4_flex = { version = "0.14.0", default-features = false, features = ["safe-decode", "safe-encode"] }`, packing and unpacking one chunk through two fixed buffers; its module is 4.4 KiB and holds 128 KiB of memory that never grows. The markdown worker compiles it beside the parser and posts it, or posts it absent if its compile fails; the page instantiates it with `new WebAssembly.Instance` the first time a full chunk needs packing. Without it, chunks stay plain UTF-8. lz4_flex 0.14.0 is the newest release. Considered and not taken: lz4-wasm 0.9.2, which wraps lz4_flex 0.9.2 and has not been published since April 2022; zstddec 0.3.1, which only decodes, fixes a 16 MiB heap, cost about 15 MiB of process memory once used and unpacks two to three times slower; and fflate 0.8.3, which unpacks about ten times slower. The safe build costs about 10% over the checked build at the median for no unsafe code in the codec.
7. **The page's policy is unchanged.** The page compiles no WebAssembly; it instantiates only modules the markdown worker compiled and posted: the parser, the compression module and the workflow checks' module. Under the page's `script-src 'self'`, Electron 44.7.0 refuses `WebAssembly.compile` on the page and runs both `WebAssembly.instantiate(module)` and `new WebAssembly.Instance(module)` on a module a worker compiled.
8. **Notices ship with it.** The crate's build writes the notices and license files of every Rust crate compiled into the module, lz4_flex's MIT license among them, and the packaged app's third-party notices carry them.

**Budget:** an 8 MiB reply sits near or under the 120 MB `renderer-heap-at-rest` budget, the first row inside the 800 ms `time-to-first-transcript-row` budget, and a far jump costs well under a frame. The build measures once against both.

**The build proves:** a far jump into a long table and into a block over the cap is formatted on its first frame; a multibyte character at a chunk edge slices, copies and selects as the source text; a body replaced while its blocks are drawn keeps the old blocks' text and trees until they leave; a definition arriving after the blocks that use it re-parses them, resolved; a page parser not yet ready holds the first draw, a failed one sends the body to the worker, and a failed codec leaves chunks plain; the cut equals one whole-document parse over every hand case, whole and streamed, and fails with a lag of one.

### Thesis — Why This Option

Nothing a person sees changes: the same parser draws every block from the same text with the same preamble, and no block is drawn unformatted. Parsing on the page is cheap enough that keeping trees buys nothing: a far jump's 32 blocks parse in a quarter to a third of a millisecond more than reading kept trees, and a single block parses in about 10 µs, faster than unpacking a kept tree. Dropping kept trees removes the bulk parse the first draw waited on and the worker's parser growth that never shrinks. One reader with typed records cuts the bookkeeping from 28.5 MB to 2.5 MB on the bench reply and removes one of two 121 ms passes. Packed UTF-8 halves a docs-like reply's text (16.8 to 8.4 MB), and lz4 brings it to 4.8 MB, with one chunk unpacked in 12.3 µs at the median. Summed from measured parts, an 8 MiB docs-like reply's text and bookkeeping go from 19.4 MB to about 5 MB, and the bench reply's from 36.9 MB to about 12.8 MB.

The parser's own cut makes live equal saved and both equal a whole-document parse: it matched one whole parse on three 8 MiB corpora and 42 hand cases, and streamed at a lag of two it matched on every corpus and case, where a lag of one failed on loose ordered lists. CommonMark backs the lag: only the last open block changes as text arrives, except through link definitions and list looseness. It moves an 8 MiB cut of 71–274 ms into the worker, off the page.

Every layer has precedent: an editor drops far blocks' parsed data and re-parses on return (Tachyon), VS Code holds its text with arrays of line starts and its tokens in typed arrays, agent apps cut at the parser's own top-level offsets with a lag (OpenAgents, DeepSeek Harness), and a posted compiled module is instantiated without compiling again.

## Alternatives Considered

### Option A: Parse on the page, typed records, packed text, the parser's cut (Chosen)

- **What:** the decision above.
- **Steel man:** the smallest window memory measured, the same draw as a whole-document parse, and no wait on another thread when a block mounts.
- **Weaknesses:** a second parser instance whose memory lasts the app's life, an idle start task, and a third Rust crate; see Consequences.

### Option B: Keeping each block's tree, compressed (Rejected)

- **What:** keep the worker's trees and pack each buffer (fflate took a block's buffer from 578 to 232 bytes), or pack many into a few large buffers.
- **Why rejected:** unpacking a kept tree took 13.5–23 µs against 7.6–13.1 µs to parse the block again, it still leaves about 21 MB of buffers on an 8 MiB reply, and it keeps the bulk parse and the worker's growth.

### Option C: Holding a jump until the worker answers, or blocking the page on it (Rejected)

- **What:** delay the scroll until the worker's tree lands, or wait for it synchronously.
- **Why rejected:** a wheel or trackpad scroll moves the box natively, outside the scroll chokepoint, so the window would show blank space. A synchronous wait needs `Atomics.wait`, which throws on the page ("Atomics.wait cannot be called in this context").

### Option D: A second, faster parser for jumps (Rejected)

- **What:** draw a far jump with a JavaScript parser and replace it with Sätteri's tree later.
- **Why rejected:** Sätteri differs from CommonMark and GFM in seven known cases (bruits/satteri#326), so a block would draw differently depending on how a person reached it.

### Option E: Paging the text in from main or the daemon (Rejected)

- **What:** keep the text out of the page and read the ranges near the reading position on demand.
- **Why rejected:** a read took 0.16–0.19 ms median from main and 0.45–0.49 ms from a stand-in daemon for 4 KiB, but a busy process has no upper bound on delay, so native scrolling can outrun the band and draw blank; the only backstop is a blocking `sendSync`, which turns a miss into a frozen page and which Electron calls a last resort. Paging from main also saves nothing for the system, which only moves the text.

### Option F: Placeholders, or plain text until parsed (Rejected)

- **What:** draw a placeholder or the unformatted text while a block's tree is on its way, as some editors and chat apps do.
- **Why rejected:** both are visible, and a block is never drawn before it is formatted.

### Option G: zstddec, fflate or lz4-wasm as the codec (Rejected)

- **What:** pack the chunks with zstd (zstddec 0.3.1 to unpack), deflate (fflate 0.8.3), or the published lz4-wasm 0.9.2.
- **Why rejected:** zstddec packs a docs-like reply to 3.17 MB against lz4_flex's 4.76 MB, but its module fixes a 16,512 KiB heap, the process grew by about 15 MiB once it unpacked, it unpacks two to three times slower (34.5 against 12.3 µs at the median), it has no encoder, and its module was last built in June 2025; its saving pays back only past about nine such replies open at once. fflate unpacks about ten times slower (127 µs at the median). lz4-wasm wraps lz4_flex 0.9.2 and has not been published since April 2022.

### Option H: Making the hand-written scan exact (Rejected)

- **What:** keep cutting with the blank-line scan on the page, and fix its cases.
- **Why rejected:** it drew 9 of 42 hand cases differently from a whole-document parse (an HTML block holding a blank line, so `<!-- a\n\nb -->` showed `b -->`; footnote continuations and indented lists drawn as code blocks) and cut inside an HTML comment three times in a corpus of the repository's docs. Making it exact means a block parser of our own, exact only as far as fuzzing against Sätteri reaches.

### Option I: marked's block lexer for both live and saved (Rejected)

- **What:** cut every body with marked's block tokens, as Streamdown does.
- **Why rejected:** it cut inside 4 of 42 hand cases (footnotes, math holding a blank line), and it is a second parser (14 KB gzipped) whose cut needs merges to agree with Sätteri's.

## Reversibility Assessment

- **Reversal cost:** low. The page parser, the records, the packed text and the cut sit behind the block reader and the text handle; no stored data or wire changes.
- **Blast radius:** the transcript's markdown bodies, the markdown worker, the text handle and the `compression` package.
- **Migration path:** keeping trees again is the worker path the failed-parser case still runs; a different codec swaps the crate's module behind the same pack and unpack calls.
- **Point of no return:** none.

## Consequences

### Positive

- A long reply's window memory is its packed text plus a few typed arrays, and no tree is kept for a block off screen but a block too long for the page, held as the worker's binary tree, packed.
- The worker's bulk parse, and the parser growth it caused, is gone; the first draw no longer waits for every block.
- Live and saved replies cut the same way, equal to a whole-document parse, and a reference link defined in another block draws as a link.
- The page loses its synchronous scan, up to 30 ms on an 8 MiB reply.

### Negative (accepted trade-offs)

- The page's parser costs about 3 MB to start and grew 13 MB over 19,200 parses, and WebAssembly memory never shrinks while an instance lives. Once the page's parser or the worker's has grown past its growth limit, the next quiet moment replaces it with a fresh instance, which takes 18.1 to 23.3 ms to start, paid while the app is quiet, so the growth is returned.
- Starting it is an 18–23 ms task and its first parse 8.5–9.0 ms, both run while idle; until it is ready a body's first draw waits.
- A far-jump frame costs about 0.2–0.3 ms more than reading kept trees, 4.3 ms at worst.
- The loader and parser JavaScript, about 548 KB unminified in a scratch bundle, loads on its own lazy chunk.
- The cut costs the worker 71–274 ms for an 8 MiB body and +5 to +12 MiB of WebAssembly memory that plateaus over repeated cuts; a huge saved reply's first draw waits on it.
- Encoding on the page leaves a transient copy, 8.4 MB of backing memory for an 8 MiB two-byte body, freed only later.
- The repository builds a third Rust crate, and its toolchain names the `wasm32-unknown-unknown` target.

### Unknowns

- An 8 MiB reply's memory at rest and its settle are measured in the browser tier, beside a bench page that holds 90–105 MB on its own and with React's development build; the app's own budget harnesses measure the fixture scenarios, which hold no reply that long. So where an 8 MiB reply sits in the packaged app against the 120 MB `renderer-heap-at-rest` budget is read off the browser tier, not measured in the app.
- The page figures come from Playwright's Chromium 156, not Electron 44.7.0's own Chromium.
- Whether the transient encoding copy is retained at rest: if it is, the bytes come from main already encoded.

## References

### Research Conducted

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Sätteri | Docs | A Rust markdown and MDX parser shipped to the browser as a WebAssembly module; MIT | <https://github.com/bruits/satteri> |
| Sätteri's pulldown-cmark fork | Docs | "A fork of pulldown-cmark, adapting it for use in satteri"; the first pass resolves the block structure over the whole input | <https://raw.githubusercontent.com/bruits/satteri/HEAD/crates/satteri-pulldown-cmark/README.md> |
| bruits/satteri#326 | Issue | Seven cases where Sätteri parses differently from CommonMark and remark-gfm | <https://github.com/bruits/satteri/issues/326> |
| CommonMark 0.31.2, "A parsing strategy" | Spec | Only the last open block changes as lines arrive, except through link reference definitions and list looseness; HTML block type 2 ends at a line containing `-->` | <https://spec.commonmark.org/0.31.2/> |
| Streamdown `parse-blocks.tsx` | Source file | One cutter (marked's block tokens) for streaming and finished text, with merges for HTML and `$$`; footnotes or a link definition make the reply one block | <https://github.com/vercel/streamdown/blob/32050fcc8b5ebe0a7011a047eba2896e55cac0e0/packages/streamdown/lib/parse-blocks.tsx#L105-L365> |
| OpenAgents `incremental.rs` and issue #9834 | Source file | Cuts at the parser's top-level offsets, so the blocks always equal a parse of the whole source; reparses from the last top-level block, and from the start once a link definition appears | <https://raw.githubusercontent.com/OpenAgentsInc/openagents/98e1a56f1b845f22da5dd755e512506028b7729e/crates/rust-native/src/markdown/incremental.rs>, <https://github.com/OpenAgentsInc/openagents/issues/9834> |
| DeepSeek Harness `incremental.ts` | Source file | Freezes all but the last two top-level blocks, cut at micromark's own offsets | <https://github.com/deepseek-ai/deepseek-harness/blob/21638c56315ae6a2b552d6091945d3144c9af32e/packages/client/ui-primitives/src/markdown/incremental.ts#L1-L38> |
| Nession #1184 | Issue | The freeze boundary is the parser's own end offset, not a hand-made blank-line scanner | <https://github.com/BestNathan/nession/issues/1184> |
| Tachyon PR #60 and ADR 0005 | Pull request | Clean blocks far from the viewport release their parsed data and re-parse on return; a streamed load equals a full parse, property-tested; its hand pre-scan desynced inside an open HTML block | <https://github.com/DailenG/tachyon/pull/60>, <https://github.com/DailenG/tachyon/blob/36679dc6fa4b35742bcfe16ffd1b1b2b849db2b4/docs/adr/0005-incremental-reparse-by-block-windows.md> |
| MDN, `WebAssembly.Module` | Docs | A compiled module "can be efficiently shared with Workers, and instantiated multiple times" | <https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Module> |
| V8 `wasm-engine.h` | Source file | A module posted to another thread shares its compiled code | <https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/wasm/wasm-engine.h> |
| V8 `backing-store.cc` | Source file | A WebAssembly memory reserves address space and makes only its `initial` pages writable | <https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/objects/backing-store.cc> |
| MDN, `Atomics.wait` | Docs | Throws on the main thread | <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait> |
| WebAssembly CSP proposal and issue #48 | Spec | Compilation is gated by the content security policy; instantiating a module compiled elsewhere is an open question the proposal leaves to hosts | <https://github.com/WebAssembly/content-security-policy/blob/main/proposals/CSP.md>, <https://github.com/WebAssembly/content-security-policy/issues/48> |
| Chromium issue 40797808 | Issue | Worker compilation under a content security policy | <https://issues.chromium.org/issues/40797808> |
| VS Code, syntax highlighting optimizations | Docs | A line's tokens are held in a binary-searchable typed array rather than as objects, each of which costs far more than its numbers | <https://code.visualstudio.com/blogs/2017/02/08/syntax-highlighting-optimizations> |
| VS Code, text buffer reimplementation | Docs | Text held in buffers with a `lineStarts` array each sits "very close to the original file size" after loading, where an array of line strings used "roughly 20 times the initial file size" | <https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation> |
| V8 `string.h` | Source file | One-byte and two-byte strings, the one-byte limit at U+00FF, and `SlicedString::kMinLength = 13`, so a slice keeps its parent alive | <https://github.com/v8/v8/blob/main/src/objects/string.h> |
| TanStack Virtual, `Virtualizer` API | Docs | `getItemKey` and the size cache keyed by it | <https://raw.githubusercontent.com/TanStack/virtual/main/docs/api/virtualizer.md> |
| Electron `ipc-renderer.md` | Docs | A synchronous message "will block the whole renderer process until the reply is received, so use this method only as a last resort" | <https://github.com/electron/electron/blob/main/docs/api/ipc-renderer.md> |
| lz4_flex 0.14.0 | Registry | Published July 14, 2026, MIT; `safe-decode` and `safe-encode` build it with no unsafe code | <https://crates.io/crates/lz4_flex> |
| lz4_flex README | Docs | A pure-Rust LZ4 block and frame implementation with safe and unsafe builds | <https://raw.githubusercontent.com/PSeitz/lz4_flex/main/README.md> |
| lz4-wasm `Cargo.toml` | Source file | lz4_flex 0.9.2 with `checked-decode` inside; the package was last published April 27, 2022 | <https://github.com/PSeitz/lz4-wasm/blob/main/Cargo.toml> |
| zstddec 0.3.1 | Registry | A zstd decoder only, built with emscripten's growable heap; "Last built June 2025, zstd v1.5.7" | <https://www.npmjs.com/package/zstddec> |
| fflate README | Docs | Publishes relative speed against other JavaScript codecs and no absolute figures | <https://raw.githubusercontent.com/101arrowz/fflate/master/README.md> |
| rustup overrides | Docs | A `rust-toolchain.toml` names the channel and targets for a folder | <https://rust-lang.github.io/rustup/overrides.html> |
| Parsing on the page | Measured (ours) | Oct 12, 2026, headless Chromium 156, page main thread, not cross-origin isolated: far jump of 32 blocks 0.2–0.3 ms median and 4.0–4.3 ms worst; start 18.1–23.3 ms; first parse 8.5–9.0 ms; +3 MB to start and +13 MB over 19,200 parses; no thread started by the loader; `Atomics.wait` throws | — |
| The parser's memory under the app's traffic | Measured (ours) | Oct 12, 2026: a worker parsing 99,231 blocks one message each went from 15 to 317 MB of footprint, parser memory 324 MiB, 285 MB three seconds later; on the page at frame pace the parser memory grew 0.75 to 1.25 MiB over 600 frames | — |
| Copies and records of a long reply's text | Measured (ours) | Oct 12, 2026, in Electron: 8 MiB of text is 8.39 MB one-byte and 16.78 MB two-byte; two readers' records 28.5 MB against 2.51 MB as typed arrays; reads from main 0.16–0.19 ms and from a stand-in daemon 0.45–0.49 ms median for 4 KiB, with no bound under load | — |
| Chunk codecs | Measured (ours) | Oct 12, 2026, Electron 44.7.0 as Node, 8 MiB docs-like text in 16 KiB chunks: lz4_flex safe 4.76 MB, unpack 12.3 / 64.0 µs median / p99, 4.4 KiB module and 128 KiB memory that never grows; zstddec 3.17 MB, 34.5 / 133 µs, 16,512 KiB of module memory and about 15 MiB of process growth once used; fflate 3.33 MB, 127 / 497 µs; lz4-wasm 4.71 MB, 14.5 / 69.8 µs | — |
| Held trees of over-cap blocks | Measured (ours) | Oct 12, 2026, headless Chromium 156, lz4_flex in 16 KiB chunks: an 8 MiB reply of 175 repetitive 48,000-character paragraphs held 1.57 MB for 8.41 MB of their UTF-8 text, 18.08 MB unpacked; a 112 KB paragraph of the repo's own prose packed to 1.37x its text (2.25x unpacked), a 115 KB one to 1.68x (2.82x), the same lines as one tight list to 1.44x (2.38x), and a code fence to 0.98x (2.00x) | — |
| An 8 MiB reply in the browser tier | Measured (ours) | Oct 13, 2026, headless Chromium 156 with React's development build, heap plus backing 3 s after settle on a bench page of 95 MB alone: prose 105.3 MB, settled in 380 ms; headings, formulas and small tables of formulas 115.2 MB, 2,951 ms; 175 paragraphs of 48,000 characters 109.3 MB, 356 ms, holding 1.57 MB of packed trees; no task over 50 ms in any | — |
| Page instantiation of a worker-compiled module | Measured (ours) | Oct 12, 2026, Electron 44.7.0 with the app's own policies: the page's `WebAssembly.compile` is refused; `WebAssembly.instantiate(module)` and `new WebAssembly.Instance(module)` on a module a worker compiled succeed | — |
| The block cut | Measured (ours) | Oct 12, 2026, Electron 44.7.0 as Node: the parser's cut in 64 KiB windows at a lag of two equals a whole-document parse on three 8 MiB corpora and 42 hand cases, live and saved; a lag of one fails; 71–274 ms for 8 MiB, 0.44–2.70 ms for 64 KiB; +5 to +12 MiB of WebAssembly memory with the root-and-children read against +46 MiB per pass with the serialized tree; the scan drew 9 of 42 cases differently and marked 4 | — |

### Related ADRs

- [ADR-042](./042-diagrams-drawn-by-merman.md): the worker policy that lets a dedicated worker alone compile WebAssembly, which this decision keeps.
