# ADR-033: One Syntax Colorer In The Daemon

| Field         | Value                      |
| ------------- | -------------------------- |
| **Status**    | `accepted`                 |
| **Type**      | `Type 2 (one-way door)`    |
| **Domain**    | Rendering, Daemon Services |
| **Date**      | 2026-09-21                 |
| **Author(s)** | Claude (AI-assisted)       |
| **Reviewers** | Sawmon Abo                 |

---

## Context

Three surfaces draw source code: the transcript's code blocks, the diff in Review, and a file opened on its own. The console runs on the machine that owns the files and, through Remote Control, on other devices that do not. The obvious shape — a `shiki` instance in each renderer process, in a Worker above about four kilobytes of source, coloring diff lines in the same Worker — puts a copy of the colorer and its grammars behind every window and every remote device. `shiki` is already a dependency of the desktop package.

## Problem Statement

Who turns source text into colored spans, how many times, and what happens to those spans when the theme changes?

### Trigger

The console design shows the same file in the flow, in Review and in the file view, on more than one device, under its themes and color schemes, which can change while the file is open.

---

## Decision

**One colorer, in the daemon, and every surface paints the spans it is handed.**

- The daemon reads a file once, computes its color spans with `shiki`, and keeps them against what the file holds, so the same file opened in the flow, in Review and in the file view is colored from one read, and a second open costs nothing.
- A span travels as a **class that names a kind of token**: keyword, name, string, number, comment for code; inserted, deleted and hunk for a `diff` block's added lines, removed lines and `@@` ranges; heading, emphasis and inline code for Markdown's own syntax. The renderer maps each class to a theme token. A span is never a color written on the element.
- **A `diff` code block and a Markdown file are colored as GitHub draws them**: the block's `+` lines green (the theme's `ansi-green` role) and `-` lines red (`ansi-red`), the terminal's pair, since the red attention role is kept for a failure; its `@@` ranges dimmed (`text-faint`). Markdown's headings and inline code take `code-name`, its emphasis `code-keyword`, and a link's text `code-string` through the string class. Each sign and mark (`+`, `-`, `@@`, `#`, `*`, a backtick) colors with what it marks. The rest of a hunk's `@@` line and a diff's `diff --git` and `index` lines stay plain: the diff grammar gives them no scope of their own.
- **A Markdown file's fenced blocks and front matter are always colored in their own language.** Before a file is colored, the thread loads the grammar of every colorable language the file's text opens, read from the Markdown grammar's own fence and front-matter rules, so the same text gives the same spans whatever the thread colored before and the cache never keeps a plain copy.
- Changing the theme or the color scheme repaints the same spans in place. No block is colored twice, and none flashes plain first.
- A diff takes a first pass from its own lines the moment it opens, so it is colored before the whole file's spans arrive, and corrects itself when they do. A string that opens above the hunk is the case that changes.
- A file whose language is not recognized stays plain and asks the daemon for nothing.
- The renderer holds no `shiki` instance and no Worker in the renderer colors anything. `shiki` belongs to the daemon package, at the pin the desktop package uses, and not to the desktop package.
- **The daemon tokenizes on a worker thread of its own and keeps the spans on its main thread.** The thread starts on the first read the span cache does not hold and ends after five minutes with nothing asked, so the memory its grammars and regex engine take goes back to the system. Code already colored is answered from the cache at once; the first read in a language after a quiet spell takes up to about 0.3 s to color.
- **The thread is also ended once its heap and WebAssembly memory pass 128 MiB**, right after the read that took it past, and the next read starts a fresh one that loads only the grammars asked for from then on. The regex engine's memory never shrinks while its thread lives, so only an end gives it back. The ceiling keeps the thread's peak inside its budget; a higher one would let each heavy grammar, 35 to 40 MiB of WebAssembly memory, push that peak further. The colors are the same, since a fresh thread runs the same engine and grammars.
- **A line the thread cannot finish within 3 s stays plain while the rest of the file is colored**, as an over-long line does. The thread is ended and a fresh one colors the file again with that line plain. The slowest legitimate line measured, 19,999 characters of Go on a fresh thread, took 300 ms. The limit bounds a line that started and has not ended, never the thread's start or a grammar's load, which are bounded work: a slow machine waits for them, and one that fails rejects the read.
- **A read nobody waits for any more is never colored.** Reads of the same code share one tokenization; a code block's read names the block, and the block's next read on the same connection replaces it while it waits, as a block whose code is still arriving asks again for each version; a connection's reads go when it closes. A tokenization no read waits for leaves the line before its turn, keeping nothing of its source, so at most one waits for each block on each connection.
- **The engine is `shiki`'s Oniguruma WebAssembly engine.** Its JavaScript engine was the other candidate: over one real or hand-written file in each of the 15 languages, colored with the daemon's own span theme, both engines gave the same colors in 14 languages, and in SQL the JavaScript engine left 50 characters plain or in the wrong class where Oniguruma colors them (a `CREATE TABLE` name, matched by a pattern with a backreference). Correctness decides it; `shiki`'s own compatibility report lists SQL as matching, which this file disproves. Oniguruma is also the engine TextMate grammars are written for and resists runaway backtracking, which reports against the JavaScript engine show freezing a thread. It costs more memory while the thread is up (WebAssembly memory grows with each grammar's compiled patterns, about 21 to 53 MB for each of the JavaScript-family grammars, and never shrinks while the thread lives) and the same once the thread ends; warm calls cost about the same (about 1 ms for 1.7 KB of TypeScript on either engine).

### Budget

The workload: one read in each of the 15 languages, a real or hand-written file of 1 to 37 KB each, then four TypeScript and four TSX files read alternately, then nothing asked. Measured on macOS with Node 24.21, against the same process before its first read. Every figure here is resident memory (RSS, as `ps` and `process.resourceUsage().maxRSS` report it), not footprint (`phys_footprint`, what Activity Monitor's Memory column shows), which is lower. RSS is the whole process's, so the thread's own heap and its WebAssembly memory are counted:

| State | Resident memory (RSS) the colorer adds | Measured |
| --- | --- | --- |
| Once the thread has ended after five quiet minutes | 30 MB at most | 16.5 MB under the process's reading before its first read in the shipped build's run, and 25 to 29 MB over it in earlier runs of a thread ended the same way; the main thread's live heap 0.4 MB over |
| While the thread is up | 160 MB at most | 154 MB at the peak, the process's own high-water mark; before the ceiling, a thread holding all 15 grammars took 248 MB |
| The span cache | 1/2048 of physical memory at most, 8 MB on a 16 GB machine | bounded by its byte size |

A change that raises a figure past its budget fails. The built daemon itself, idle before any read, holds 220 to 225 MB of RSS (182 to 189 MB of footprint) 10 to 15 s after start, so at the colorer's peak the whole daemon reaches about 375 MB of RSS, past its 256 MB operating target, which is an RSS figure ([deployment-topology §Local Daemon Memory Instrumentation And Budget Triggers](../architecture/deployment-topology.md#local-daemon-memory-instrumentation-and-budget-triggers)); that document's trigger decides what follows, and colors are never cut to meet it. In the measured run the thread was ended twice at the ceiling, after a 25 KB TSX file read after TypeScript, and after Go; the reads that followed, JavaScript and SQL, took 161 ms and 30 ms on their fresh threads. In the alternation of smaller TypeScript and TSX files, 0.5 to 8 KB, the pair stayed on one thread, and every read after the first two took 3 to 62 ms.

### Thesis — Why This Option

- **One read, many surfaces.** The daemon already owns the file. Coloring beside the read means three surfaces and any number of devices share one result.
- **The theme is the renderer's; the grammar is not.** Sending token kinds instead of colors makes a theme switch a style change with no recomputation and no flash.
- **Other devices get color for free.** Another device that reaches the session through Remote Control paints spans it is handed and ships no grammar files.
- **The renderer bundle shrinks.** Grammars and the coloring engine leave the renderer, which has a written bundle budget.

### Antithesis — The Strongest Case Against [T2]

Coloring in the renderer is the library's common deployment, it keeps typing latency local, and it costs the daemon nothing. Moving it puts a round trip between a file opening and its color, puts central-processor work for every open file on the process that also supervises provider runs, and makes span payloads a wire format the project must now keep stable. A generic token-kind vocabulary is also coarser than the themes `shiki` ships.

### Synthesis — Why It Still Holds [T2]

Nothing in the console is a code editor: every surface that draws code draws text that already exists in a file or a reply, so there is no typing latency to protect. The round trip is hidden by the two rules above: a diff colors itself from its own lines first, and spans are cached against the file's content. The daemon's work is bounded by the same cache, and its budget is written and measured like every other. The cache is `lru-cache`'s `LRUCache`, bounded by bytes: `maxSize` with a `sizeCalculation` per entry. The wire format is the token kinds' class names, which is the smallest stable contract available. The coarse vocabulary is a design choice: code takes its colors from the console's own theme tokens, so a finer vocabulary would have nothing to map to.

---

## Alternatives Considered

### Option A: One colorer in the daemon, token-kind spans on the wire (Chosen)

- **What:** As decided above.
- **Steel man:** One computation per file content, no flash on theme change, no grammars in any client.
- **Weaknesses:** A new wire shape, and work on the daemon.

### Option B: A colorer per renderer process, in a Worker (Rejected)

- **What:** A `shiki` instance in each renderer process, coloring source in a Worker above about four kilobytes and coloring diff lines in the same Worker.
- **Steel man:** Standard, local, no wire format.
- **Why rejected:** Each window and each device recomputes the same file, each ships the grammars, and a theme change either recolors every block or needs the token-kind mapping anyway.

### Option C: Color in the daemon but send resolved colors (Rejected)

- **What:** The daemon applies the theme and sends colored markup.
- **Steel man:** The renderer does nothing at all.
- **Why rejected:** Every theme or color-scheme change invalidates every cached span and forces a refetch, which is the flash this decision exists to remove. The daemon would also need to know each client's theme.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `shiki` runs in the daemon's Node runtime at the pinned version | It is a Node library; the pin is the one the desktop package already uses | A different colorer would be chosen behind the same wire shape |
| 2 | Eleven token kinds — keyword, name, string, number and comment for code, inserted, deleted and hunk for a diff, heading, emphasis and inline code for Markdown — are enough for the console's themes | Four code tokens, the faint token and the terminal's green and red are what the themes define for them | Another kind is one more class name |
| 3 | Span payloads are small next to the file text | A span is a range and a class name | Large files would need spans sent for the visible range only |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Coloring a very large file stalls the daemon | Med | Med | The daemon's event-loop delay under the large-file workload | Tokenize on the daemon's own worker thread, so the main thread only waits; a line past the time limit stays plain and the thread is started again |
| Spans arrive after the text and the block repaints visibly | Med | Low | A visible change of color on open | The diff's own first pass; plain text is a legitimate first frame for a whole file |
| The span cache grows without bound | Low | Med | Resident memory over budget | The cache is keyed on content and bounded by bytes, each entry charged its spans, its key and its own overhead |
| The grammars' memory stays taken after coloring ends | Med | Med | Resident memory over the idle budget | The tokenizing thread ends after five quiet minutes, and its memory goes back with it |
| Reading many languages grows the thread past its budget | Med | Med | Resident memory over the running budget | The thread is ended once its heap and WebAssembly memory pass 128 MiB, and a fresh one loads only what is asked next |
| Reads pile up faster than the thread colors them, as a block whose code is still arriving asks again for each version | Med | Med | Waiting reads and their sources held in memory | A block's newer read replaces its waiting one, a closed connection's reads are dropped, and a tokenization nobody waits for leaves the line holding nothing of its source |

## Reversibility Assessment

- **Reversal cost:** Days to move the colorer back, and only while every client still has a colorer of its own; the token-kind mapping would stay.
- **Blast radius:** The transcript, Review, the file view, the daemon's file reads and the Remote Control clients.
- **Migration path:** Re-add the renderer dependency and color locally from the same class vocabulary.
- **Point of no return:** When a Remote Control client ships that has no colorer of its own.

## Consequences

### Positive

- One coloring per file content across every surface and device.
- A theme change is a style change.

### Negative (accepted trade-offs)

- The daemon does rendering-adjacent work. Accepted because it already owns the read and the result is shared.
- The first read in a language after the thread has ended pays the grammar's load again, up to about 0.3 s. Accepted because the thread's memory goes back in return.
- A thread ended at its memory ceiling drops every grammar, so a read in a language it held pays that load again too. Accepted because the ceiling keeps the thread's peak inside its budget.
- A code block that leaves the screen while its read waits is still colored once, since nothing on the wire cancels one request; its spans land in the cache for when it is drawn again.

---

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Coloring computations when one file is opened on three surfaces | One | Count colorer calls in a daemon test that opens the file three ways | When the colorer lands |
| Blocks repainted plain during a theme change | Zero | The browser test tier's theme-switch scenario | When the colorer lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Feature census of reference app B, a Rust desktop console | Primary research | Its transcript colors a recognized language off the main thread, time-sliced, from a cache keyed on the document and bounded in both entries and bytes, and paints the result as colored runs rather than as styled markup | Read for the console design; the reading is summarized here |
| Feature census of reference app B, its editor and file preview | Primary research | Those two surfaces are served from a shared cache rather than each coloring the file again, and they recompute on a short delay after an edit instead of per keystroke; a file whose language is not recognized falls back to plain text | Read for the console design; the reading is summarized here |
| `shiki` regex engines | Documentation | The JavaScript engine needs no WebAssembly file and is faster for some languages; the Oniguruma engine loads its WebAssembly with `createOnigurumaEngine(import('shiki/wasm'))` | https://shiki.style/guide/regex-engines |
| `shiki` JavaScript engine compatibility report (4.4.3) | Documentation | Lists every one of the 15 languages, SQL among them, as giving the same result as the WebAssembly engine, which the daemon's own comparison disproves for SQL | https://shiki.style/references/engine-js-compat |
| `shiki` issue 1026 | Issue | Oniguruma has built-in protections against runaway backtracking that V8's regex engine lacks | https://github.com/shikijs/shiki/issues/1026 |
| Node.js worker threads | Documentation | Each worker has its own heap and `resourceLimits`; `terminate()` stops its JavaScript as soon as possible | https://nodejs.org/api/worker_threads.html |
| `shiki` 4.5.0 and its Oniguruma engine, source | Source | A highlighter's `dispose()` frees its grammars' compiled patterns, and a new highlighter reuses that WebAssembly memory, but the memory itself only grows (`wasmMemory.grow`), so only ending the thread returns it | `@shikijs/primitive` and `@shikijs/engine-oniguruma` in the installed package |
| `p-limit` 7.3.3 | Source | Its queue has no way to take out one waiting job, so a dropped tokenization keeps its turn and does no work there; `p-queue` takes a waiting job out on an abort, but the daemon already queues with `p-limit`, and one queue library serves it | https://github.com/sindresorhus/p-limit |

### Related ADRs

- [ADR-015: Electron Desktop App](015-electron-desktop-app.md) — the renderer that paints the spans.
