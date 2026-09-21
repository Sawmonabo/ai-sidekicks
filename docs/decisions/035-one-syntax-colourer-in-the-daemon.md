# ADR-035: One Syntax Colourer In The Daemon

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

Three surfaces draw source code: the transcript's code blocks, the diff in Review, and a file opened on its own. The console runs on the machine that owns the files and, through Remote Control, on other devices that do not. [Spec-021 §Console Libraries](../specs/021-desktop-shell-and-renderer.md#console-libraries) previously placed a `shiki` instance in each renderer process, in a Worker above about four kilobytes of source, and coloured diff lines in that Worker too. `shiki` is already a dependency of the desktop package.

## Problem Statement

Who turns source text into coloured spans, how many times, and what happens to those spans when the theme changes?

### Trigger

The locked console design shows the same file in the flow, in Review and in the file view, on more than one device, under two themes and two colour schemes that can change while the file is open.

---

## Decision

**One colourer, in the daemon, and every surface paints the spans it is handed.**

- The daemon reads a file once, computes its colour spans with `shiki`, and keeps them against what the file holds, so the same file opened in the flow, in Review and in the file view is coloured from one read, and a second open costs nothing.
- A span travels as a **class that names a kind of token**: keyword, name, string, number, comment. The renderer maps each class to a theme token. A span is never a colour written on the element.
- Changing the theme or the colour scheme repaints the same spans in place. No block is coloured twice, and none flashes plain first.
- A diff takes a first pass from its own lines the moment it opens, so it is coloured before the whole file's spans arrive, and corrects itself when they do. A string that opens above the hunk is the case that changes.
- A file whose language is not recognised stays plain and asks the daemon for nothing.
- The renderer holds no `shiki` instance and no Worker colours anything. `shiki` moves from the desktop package to the daemon package, at the same pin, and the desktop dependency is removed in the same change.

### Thesis — Why This Option

- **One read, many surfaces.** The daemon already owns the file. Colouring beside the read means three surfaces and any number of devices share one result.
- **The theme is the renderer's; the grammar is not.** Sending token kinds instead of colours makes a theme switch a style change with no recomputation and no flash.
- **Other devices get colour for free.** Another device that reaches the session through Remote Control paints spans it is handed and ships no grammar files.
- **The renderer bundle shrinks.** Grammars and the colouring engine leave the renderer, which has a written bundle budget.

### Antithesis — The Strongest Case Against [T2]

Colouring in the renderer is the library's common deployment, it keeps typing latency local, and it costs the daemon nothing. Moving it puts a round trip between a file opening and its colour, puts central-processor work for every open file on the process that also supervises provider runs, and makes span payloads a wire format the project must now keep stable. A generic five-kind vocabulary is also coarser than the themes `shiki` ships.

### Synthesis — Why It Still Holds [T2]

Nothing in the console is a code editor: every surface that draws code draws text that already exists in a file or a reply, so there is no typing latency to protect. The round trip is hidden by the two rules above: a diff colours itself from its own lines first, and spans are cached against the file's content. The daemon's work is bounded by the same cache, and its budget is written and measured like every other. The wire format is five class names, which is the smallest stable contract available. The coarse vocabulary is a design choice: code takes its colours from the console's own theme tokens, so a finer vocabulary would have nothing to map to.

---

## Alternatives Considered

### Option A: One colourer in the daemon, token-kind spans on the wire (Chosen)

- **What:** As decided above.
- **Steel man:** One computation per file content, no flash on theme change, no grammars in any client.
- **Weaknesses:** A new wire shape, and work on the daemon.

### Option B: A colourer per renderer process, in a Worker (Rejected)

- **What:** The previous specification.
- **Steel man:** Standard, local, no wire format.
- **Why rejected:** Each window and each device recomputes the same file, each ships the grammars, and a theme change either recolours every block or needs the token-kind mapping anyway.

### Option C: Colour in the daemon but send resolved colours (Rejected)

- **What:** The daemon applies the theme and sends coloured markup.
- **Steel man:** The renderer does nothing at all.
- **Why rejected:** Every theme or colour-scheme change invalidates every cached span and forces a refetch, which is the flash this decision exists to remove. The daemon would also need to know each client's theme.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `shiki` runs in the daemon's Node runtime at the pinned version | It is a Node library; the pin is the one the desktop package already uses | A different colourer would be chosen behind the same wire shape |
| 2 | Five token kinds are enough for the console's themes | Four code tokens and the faint token are what the themes define for code | A sixth kind is one more class name |
| 3 | Span payloads are small next to the file text | A span is a range and a class name | Large files would need spans sent for the visible range only |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Colouring a very large file stalls the daemon | Med | Med | The daemon's event-loop delay under the large-file workload | Colour off the main thread and bound the cache by the written memory budget |
| Spans arrive after the text and the block repaints visibly | Med | Low | A visible change of colour on open | The diff's own first pass; plain text is a legitimate first frame for a whole file |
| The span cache grows without bound | Low | Med | Resident memory over budget | The cache is keyed on content and evicted under the daemon's memory budget |

## Reversibility Assessment

- **Reversal cost:** Days to move the colourer back, and only while every client still has a colourer of its own; the token-kind mapping would stay.
- **Blast radius:** The transcript, Review, the file view, the daemon's file reads and the Remote Control clients.
- **Migration path:** Re-add the renderer dependency and colour locally from the same class vocabulary.
- **Point of no return:** When a Remote Control client ships that has no colourer of its own.

## Consequences

### Positive

- One colouring per file content across every surface and device.
- A theme change is a style change.

### Negative (accepted trade-offs)

- The daemon does rendering-adjacent work. Accepted because it already owns the read and the result is shared.

### Unknowns

- The daemon's cost on a repository-sized diff. Measured against a budget set before the colourer is built.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [x] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Colouring computations when one file is opened on three surfaces | One | Count colourer calls in a daemon test that opens the file three ways | When the colourer lands |
| Blocks repainted plain during a theme change | Zero | The browser test tier's theme-switch scenario | When the colourer lands |

---

## References

No outside research was needed; the decision rests on the specifications linked above.

### Related ADRs

- [ADR-016: Electron Desktop Shell](016-electron-desktop-shell.md) — the renderer that paints the spans.

## Decision Log

| Date       | Event    | Notes                            |
| ---------- | -------- | -------------------------------- |
| 2026-09-21 | Accepted | Decided with the console design. |
