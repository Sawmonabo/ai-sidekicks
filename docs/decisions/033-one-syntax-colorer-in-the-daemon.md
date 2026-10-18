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

Three surfaces draw source code: the transcript's code blocks, the diff in Review, and a file opened on its own. The console runs on the machine that owns the files and, through Remote Control, on other devices that do not. The obvious shape — a `shiki` instance in each renderer process, in a Worker above about four kilobytes of source, coloring diff lines in the same Worker — puts a copy of the colorer and its grammars behind every window and every remote device.

## Problem Statement

Who turns source text into colored spans, how many times, and what happens to those spans when the theme changes?

### Trigger

The console design shows the same file in the flow, in Review and in the file view, on more than one device, under its themes and color schemes, which can change while the file is open.

---

## Decision

**One colorer, in the daemon, and every surface paints the spans it is handed.**

- The daemon reads a file once, computes its color spans with `ferriki-textmate`, and keeps them against what the file holds, so the same file opened in the flow, in Review and in the file view is colored from one read, and a second open costs nothing.
- A span travels as a **class that names a kind of token**: keyword, name, string, number, comment for code; inserted, deleted and hunk for a `diff` block's added lines, removed lines and `@@` ranges; heading, emphasis and inline code for Markdown's own syntax. The renderer maps each class to a theme token. A span is never a color written on the element.
- **A `diff` code block and a Markdown file are colored as GitHub draws them**: the block's `+` lines green (the theme's `ansi-green` role) and `-` lines red (`ansi-red`), the terminal's pair, since the red attention role is kept for a failure; its `@@` ranges dimmed (`text-faint`). Markdown's headings and inline code take `code-name`, its emphasis `code-keyword`, and a link's text `code-string` through the string class. Each sign and mark (`+`, `-`, `@@`, `#`, `*`, a backtick) colors with what it marks. The rest of a hunk's `@@` line and a diff's `diff --git` and `index` lines stay plain: the diff grammar gives them no scope of their own.
- **A Markdown file's fenced blocks and front matter are always colored in their own language.** The highlighter registers every colorable language's grammar when it is built and compiles each on its first use, so the same text gives the same spans whatever the thread colored before and the cache never keeps a plain copy.
- Changing the theme or the color scheme repaints the same spans in place. No block is colored twice, and none flashes plain first.
- A diff takes a first pass from its own lines the moment it opens, so it is colored before the whole file's spans arrive, and corrects itself when they do. A string that opens above the hunk is the case that changes.
- A file whose language is not recognized stays plain and asks the daemon for nothing.
- The renderer holds no colorer and no Worker in the renderer colors anything. `ferriki-textmate` belongs to the service, in `sidekicks-daemon`, and not to the desktop package.
- **The daemon tokenizes on one long-lived thread of its own, which holds one `ferriki-textmate` highlighter.** The highlighter is built on the first read the span cache does not hold, every colorable grammar registered and each compiled on its first use, and dropped after five minutes with nothing asked, every grammar and compiled pattern with it. Right after a drop the thread itself asks the allocator to hand the freed pages back, since the allocator returns freed memory to the system only lazily, so the memory they took goes back at once. Code already colored is answered from the cache at once; the first read in a language after a quiet spell compiles that language's grammar again.
- **The highlighter is also dropped between reads once it has colored about 400 KiB of source in a language whose grammar names scopes from the text it matches** (HTML, shell, CSS, and Markdown, which embeds them), counted since it was built: the engine keeps each such name for the highlighter's life, so the drop bounds that growth, and the next read builds a fresh one with the same colors. Nothing else the highlighter holds grows with what it colors: the compiled grammars weigh what they weigh, and an `end` or `while` pattern with a back-reference keeps only its latest compile. The drop is the idle drop's path, the thread handing the pages back after it.
- **A line the thread cannot finish within 3 s stays plain while the rest of the file is colored**, as an over-long line does, and the next line starts from the state before it, with no thread ended. The limit bounds a line that started and has not ended, the patterns compiled for the first time on that line included, never the thread's start or the highlighter's build, which are bounded work: a slow machine waits for them, and one that fails rejects the read.
- **A read nobody waits for any more is never colored.** Reads of the same code share one tokenization; a code block's read names the block, and the block's next read on the same connection replaces it while it waits, as a block whose code is still arriving asks again for each version; a connection's reads go when it closes. When the last read of a tokenization leaves, the tokenization is skipped at its turn, or stops at its next line while it runs, and keeps nothing of its source. So one tokenization waits for each block on each connection, and beside it the thread's queue holds the unwanted ones it has not reached yet, each without its source.
- **A block still arriving is colored from where its last version's complete lines ended.** The thread keeps, for its most recent blocks, the grammar state after the last complete line, the spans up to it and a digest of that text; a newer version in the same language that begins with the same text, checked by digest and never by length, is colored from that state, so each version costs only its new lines and its spans are those a whole tokenization gives. The line still arriving is colored again with each version and its state is never kept. A longer version that does not begin with that text is resumed all the same, and when the digest of its text up to its last line break differs from the saved one at the end, it is colored again from the first line. Any other version, and any drop, starts from the first line, and the kept states go with the highlighter.
- **While a reply streams, the colors of each newly finished line of its code blocks ride the session stream's frames**, as packed 32-bit runs, computed only for a subscriber that asked for colors. They never hold back a text frame: they ride the next frame after the thread answers. They are never stored, so a replay from a cursor computes them again through the span cache. `highlight.read` serves files, diffs and history.
- **The engine is `ferriki-textmate`, the TextMate tokenizer of the `ferriki` project, with its regex prefilter off, on `ferroni`, a pure-Rust port of Oniguruma.** It runs `shiki`'s own grammars and gives the same classes as `shiki`'s Oniguruma engine on all 15 languages. Oniguruma's semantics decide it: a JavaScript regex engine, the other candidate, left 50 characters of SQL plain or in the wrong class where Oniguruma colors them (a `CREATE TABLE` name, matched by a pattern with a backreference), though `shiki`'s own compatibility report lists SQL as matching. Oniguruma is also the engine TextMate grammars are written for and resists runaway backtracking, which reports against the JavaScript engine show freezing a thread.

### Budget

The workload: one read in each of the 15 languages, 76,837 visible code points in all, then nothing asked, and four sessions streaming code blocks beside it. Every figure here is resident memory (RSS, as `ps` reports it), not footprint (`phys_footprint`, what Activity Monitor's Memory column shows), which is lower. RSS is the whole process's, so a whole-process figure is an upper bound on what the colorer adds. Each budget is set from the first measurement of this workload on macOS and written here with it:

| State | What the budget bounds |
| --- | --- |
| The highlighter dropped and its pages handed back | The resident memory the colorer adds |
| The highlighter built, all 15 grammars compiled and colored | The resident memory the colorer adds |
| Scope names built from matched text, up to the rebuild after about 400 KiB of such source | The resident memory they add |
| The span cache | 1/2048 of physical memory at most, 8 MB on a 16 GB machine, bounded by its byte size |
| The first spans after a drop | The time from the read to its spans |
| One version of a streaming block | The time to color its new lines |

A change that raises a figure past its budget fails. The daemon's own figures and its operating target, an RSS figure, are in [deployment-topology §Local Daemon Memory Instrumentation And Budget](../architecture/deployment-topology.md#local-daemon-memory-instrumentation-and-budget); that document decides what follows a figure past the target, and colors are never cut to meet it.

### Thesis — Why This Option

- **One read, many surfaces.** The daemon already owns the file. Coloring beside the read means three surfaces and any number of devices share one result.
- **The theme is the renderer's; the grammar is not.** Sending token kinds instead of colors makes a theme switch a style change with no recomputation and no flash.
- **Other devices get color for free.** Another device that reaches the session through Remote Control paints spans it is handed and ships no grammar files.
- **The renderer bundle shrinks.** Grammars and the coloring engine leave the renderer, which has a written bundle budget.

### Antithesis — The Strongest Case Against [T2]

Coloring in the renderer is the library's common deployment, it keeps typing latency local, and it costs the daemon nothing. Moving it puts a round trip between a file opening and its color, puts central-processor work for every open file on the process that also supervises provider runs, and makes span payloads a wire format the project must now keep stable. A generic token-kind vocabulary is also coarser than the themes `shiki` ships.

### Synthesis — Why It Still Holds [T2]

Nothing in the console is a code editor: every surface that draws code draws text that already exists in a file or a reply, so there is no typing latency to protect. The round trip is hidden by the two rules above: a diff colors itself from its own lines first, and spans are cached against the file's content. The daemon's work is bounded by the same cache, and its budget is written and measured like every other. The cache is a `quick_cache` cache weighted by bytes, each entry charged its size. The wire format is the token kinds' class names, which is the smallest stable contract available. The coarse vocabulary is a design choice: code takes its colors from the console's own theme tokens, so a finer vocabulary would have nothing to map to.

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
| 1 | `ferriki-textmate` and `ferroni` run in the service at their pinned versions | They are pure-Rust libraries, equal to `shiki`'s classes on all 15 languages | A different colorer would be chosen behind the same wire shape |
| 2 | Eleven token kinds — keyword, name, string, number and comment for code, inserted, deleted and hunk for a diff, heading, emphasis and inline code for Markdown — are enough for the console's themes | Four code tokens, the faint token and the terminal's green and red are what the themes define for them | Another kind is one more class name |
| 3 | Span payloads are small next to the file text | A span is a range and a class name | Large files would need spans sent for the visible range only |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Coloring a very large file stalls the daemon | Med | Med | The service's other reads' latency under the large-file workload | Tokenize on the daemon's own thread, so no other work waits on it; a line past the time limit stays plain and the next line starts from the state before it |
| Spans arrive after the text and the block repaints visibly | Med | Low | A visible change of color on open | The diff's own first pass; plain text is a legitimate first frame for a whole file |
| The span cache grows without bound | Low | Med | Resident memory over budget | The cache is keyed on content and bounded by bytes, each entry charged its spans, its key and its own overhead |
| The grammars' memory stays taken after coloring ends | Med | Med | Resident memory over the idle budget | The highlighter is dropped after five quiet minutes, and the thread hands the pages back itself |
| The engine's scope-name caches grow with each new name a grammar builds from matched text | Low | Med | Resident memory over the running budget | The highlighter is dropped after about 400 KiB of such source, and a fresh one is built at the next read |
| Reads pile up faster than the thread colors them, as a block whose code is still arriving asks again for each version | Med | Med | Waiting reads and their sources held in memory | A block's newer read replaces its waiting one, and a version extending the last is colored from its saved state; a closed connection's reads are dropped, and a tokenization nobody waits for leaves the line holding nothing of its source |

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
- The first read in a language after the highlighter has been dropped compiles the grammar again, and building a highlighter parses every colorable language's grammar. Accepted because the highlighter's memory goes back in return.
- After about 400 KiB of HTML, shell, CSS or Markdown source, one read waits for a fresh highlighter to be built and its grammar compiled. Accepted because it bounds the engine's scope-name caches, with the same colors.
- The regex time limit slows every search, since the engine builds a fresh match context for each one while a limit is set. Accepted because it ends a stuck search on time and never changes a legitimate line's colors.
- A code block that leaves the screen while its read waits is not colored to the end: once its last waiting read leaves, its tokenization stops at its next line and keeps where it got to for the block's next version, so the thread stays free for the blocks on screen. A read that joins a tokenization of the same code keeps it going.

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
| The service's read queue | Design | Each queued read holds a weak reference to its source, upgraded before each line, so a read no one waits for leaves the queue and does no work | `crates/sidekicks-daemon`'s highlight module |
| `ferriki-textmate` 1.0.0 and `ferroni` 2.1.3 | Source | `ferriki-textmate` runs `shiki`'s grammars on `ferroni`, a pure-Rust Oniguruma port; with its regex prefilter off it gives the same classes as `shiki` on all 15 languages. Its registry clears every compiled grammar and its pattern cache on each grammar it registers (`registry.rs`, `add_grammar` through `set_injections`), so the highlighter registers every grammar when it is built. Its theme and each grammar cache every scope name they meet (`cached_match_root`, `BasicScopeAttributesProvider`) for the registry's life; an `end` or `while` pattern with back-references keeps only its latest compile; `set_theme` and `set_injections` clear the caches. The `ferriki` crate around it re-exports neither its registry nor its grammar configuration | <https://crates.io/crates/ferriki-textmate>, <https://crates.io/crates/ferroni> |
| `quick_cache` | Documentation | A cache bounded by a weighter, here the bytes each entry holds | <https://docs.rs/quick_cache/latest/quick_cache/> |

### Related ADRs

- [ADR-015: Electron Desktop App](015-electron-desktop-app.md) — the renderer that paints the spans.
