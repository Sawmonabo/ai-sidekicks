// The bodies scripted sessions store beside their replies, reasoning and tool output: blocks of
// prose, code, tables, math, diagrams, lists and quotes, cycled so every kind a reply draws recurs,
// and what a command and an edit print. A beat's payload carries only a body's length; the body is
// stored beside the event and a read returns it with the row.

/** Paragraphs of a reply's or a reasoning's prose. */
export const PROSE_BLOCKS: readonly string[] = [
  "The session store keeps each lane moving while the reviewer reads the diff. Every run group " +
    "stays open, and the transcript draws prose, code, tables, math and diagrams in one column.",
  "I split the window cap from the reconcile pass, so a row that leaves the window keeps its " +
    "measured height and the reader's row keeps its place when rows above it come and go. The " +
    "tests cover the cut, the admission and the anchor across a fling.",
  "The `ScrollController` writes every offset through one chokepoint, and each write names its " +
    "caller, so a jump is traceable. **Nothing** else writes `scrollTop`.",
];

/** Fenced code in several languages, and one diff. */
export const CODE_BLOCKS: readonly string[] = [
  [
    "```typescript",
    "export async function readWindow(store: SessionStore, cursor: string): Promise<Row[]> {",
    "  const page = await store.read({ before: cursor, limit: 200 });",
    "  const rows = page.entries.map((entry) => ({ id: entry.id, kind: entry.type }));",
    "  if (rows.length === 0) {",
    "    throw new RangeError(`no rows before ${cursor}`);",
    "  }",
    '  return rows.filter((row) => row.kind !== "session.heartbeat");',
    "}",
    "```",
  ].join("\n"),
  [
    "```python",
    "def percentile(samples: list[float], fraction: float) -> float:",
    '    """Nearest-rank percentile of frame samples."""',
    "    ordered = sorted(samples)",
    "    rank = max(1, math.ceil(fraction * len(ordered)))",
    "    return ordered[rank - 1]",
    "```",
  ].join("\n"),
  [
    "```rust",
    "pub fn spawn_pty(command: &CommandSpec, size: PtySize) -> Result<PtyHandle, PtyError> {",
    "    let pair = native_pty_system().openpty(size).map_err(PtyError::Open)?;",
    "    let child = pair.slave.spawn_command(builder(command)).map_err(PtyError::Spawn)?;",
    "    Ok(PtyHandle { master: pair.master, child })",
    "}",
    "```",
  ].join("\n"),
  [
    "```bash",
    "set -euo pipefail",
    "pnpm --filter @ai-sidekicks/desktop build:fixtures",
    'rg -n "dropped" results/*.log | sort | uniq -c | head -20',
    "```",
  ].join("\n"),
  [
    "```json",
    "{",
    '  "lanes": 4,',
    '  "frames": { "p50": 4.1, "p95": 8.25 },',
    '  "rows": [{ "index": 0, "kind": "prose" }, { "index": 1, "kind": "tool" }]',
    "}",
    "```",
  ].join("\n"),
  [
    "```sql",
    "SELECT e.session_id, count(*) AS rows, max(e.sequence) AS newest",
    "FROM session_events AS e",
    "WHERE e.session_id = $1 AND e.sequence > $2",
    "GROUP BY e.session_id;",
    "```",
  ].join("\n"),
  [
    "```diff",
    "-  readonly #rows: Row[] = [];",
    "+  readonly #rows = new RowRing(800);",
    "   public admit(row: Row): void {",
    '+    this.#emitter.emit({ kind: "admitted", rowId: row.id });',
    "   }",
    "```",
  ].join("\n"),
];

const TABLE_BLOCK = [
  "| Lane | State | Rows | p95 (ms) |",
  "| --- | --- | ---: | ---: |",
  "| Architect | running | 412 | 8.25 |",
  "| Implementer | waiting | 288 | 8.91 |",
  "| Reviewer | running | 640 | 7.80 |",
  "| Scout | done | 96 | 8.02 |",
].join("\n");

const MATH_BLOCK = [
  "```math",
  "\\Delta t_{frame} = \\frac{1}{f_{display}} = \\frac{1}{120\\,\\text{Hz}} \\approx 8.33\\,\\text{ms}",
  "```",
].join("\n");

const DIAGRAM_BLOCKS: readonly string[] = [
  [
    "```mermaid",
    "flowchart LR",
    "  daemon[Daemon] -->|session.subscribe| main[Main]",
    "  main --> renderer[Renderer]",
    "  renderer --> viewport{Viewport}",
    "  viewport -->|follow| tail[Tail]",
    "  viewport -->|read| anchor[Reading anchor]",
    "```",
  ].join("\n"),
  [
    "```mermaid",
    "sequenceDiagram",
    "  participant P as Person",
    "  participant R as Renderer",
    "  participant D as Daemon",
    "  P->>R: fling",
    "  R->>D: transcript.read before cursor",
    "  D-->>R: rows",
    "  R-->>P: frame",
    "```",
  ].join("\n"),
  [
    "```mermaid",
    "stateDiagram-v2",
    "  [*] --> queued",
    "  queued --> starting",
    "  starting --> running",
    "  running --> completed",
    "  completed --> [*]",
    "```",
  ].join("\n"),
];

const LIST_BLOCK = [
  "- Measure the rows the fling mounts, not the ones it skips.",
  "- Keep the reader's row in place when the window admits a stretch.",
  "  - Let go of rows past the far edge only once the gesture ends.",
  "- Keep a settled row's measured height when it scrolls back.",
].join("\n");

const QUOTE_BLOCK =
  "> A reader who scrolls back mid-turn should find every row where they left it, drawn as it " +
  "was when it settled.";

/** The blocks after a reply's opening prose, cycled through so every kind recurs. */
export const BODY_BLOCKS: readonly string[] = [
  ...CODE_BLOCKS,
  TABLE_BLOCK,
  ...DIAGRAM_BLOCKS,
  MATH_BLOCK,
  LIST_BLOCK,
  QUOTE_BLOCK,
  ...PROSE_BLOCKS,
];

/** What a test command printed, its colors as escape sequences. */
export const COMMAND_OUTPUT: string = [
  "\u001b[32m✓\u001b[0m transcript/viewport/window-cap.test.ts (24 tests) 112ms",
  "\u001b[32m✓\u001b[0m transcript/reveal/text-rope.test.ts (18 tests) 64ms",
  "\u001b[31m✗\u001b[0m transcript/feed/structure-acts.test.ts > folds a terminal group",
  "  expected 3 rows to be 2",
  "Test Files  1 failed | 2 passed (3)",
].join("\n");

/** What a file edit reported, with the diff it made. */
export const EDIT_OUTPUT: string = `Edited 2 files, 14 lines.\n${blockAt(CODE_BLOCKS, 6)}`;

/** One body block from a cycle, by any whole index. */
export function blockAt(blocks: readonly string[], index: number): string {
  const block = blocks[index % blocks.length];
  if (block === undefined) {
    throw new RangeError("a body block cycle is empty");
  }
  return block;
}

/** A body composed of these blocks, a blank line between each two. */
export function bodyOf(blocks: readonly string[]): string {
  return blocks.join("\n\n");
}
