// table-arity — structural guard for GFM tables: every row in a table carries
// the same number of cells as its header.
//
// Closes the corruption class that hit this repo twice, authored independently
// both times. In a GFM table a literal `|` splits cells EVEN INSIDE a code
// span — a backtick is not a shield — so writing `` `<env | file>` `` in a cell
// silently makes that row one cell wider than its header. The damage is not the
// miscount: prettier then re-parses the row at its true arity and REFLOWS the
// whole table to match, eating backticks and spaces at the new split
// boundaries, and every later `prettier --check` passes because prettier
// produced the corrupted form and is idempotent on it. Formatting-stable is not
// the same as correct, which is why no existing gate saw either instance:
//   - `Spec-015 §NTP Sync Precondition` — `<env | file>` widened a 3-column row
//     to 4 and the delimiter row was "repaired" to 4 dashes to match.
//   - failure-mode-catalog CAT-10 (PR #267) — an unescaped `|| true` in a
//     2-column row, caught only by a human reading the commit.
// (Durable §-anchors in this tree are convention-held, not gate-held: the
// label-cite sweep covers `packages/` + `apps/`, not `tools/`, which is how an
// earlier draft of this header shipped a §-anchor naming a heading that does
// not exist in Spec-015 — Codex, PR #269 round 1.)
//
// What the violation kinds cost, per the GFM tables extension
// (https://github.github.com/gfm/#tables-extension-, fetched 2026-07-28):
//   - delimiter vs header mismatch — "The header row must match the delimiter
//     row in the number of cells. If not, a table will not be recognized." The
//     block stops being a table outright and renders as a paragraph of literal
//     pipe text. This was the live state of the Spec-015 matrix.
//   - body row WIDER than the header — "If there are greater, the excess is
//     ignored." The surplus cell is dropped from the rendered output, so the
//     failure is silent content LOSS rather than a visible mess.
//   - body row NARROWER — missing cells render empty; benign, and flagged only
//     because it is the same authoring slip seen from the other side.
//
// The invariant is deliberately WITHIN-table: rows are compared to their own
// header, never to intent. A table whose header is itself wrong passes cleanly
// — this finds rows that disagree with their header, not headers that disagree
// with the author. That bound is what keeps the check free of judgment calls,
// and the corruption class it targets always manifests as a disagreement.
//
// Block context is tracked so that illustrative markup is never read as live
// markup: fenced blocks via the shared `markdown-fences.ts` tracker, HTML
// comments by line state, and indented code by the CommonMark three-space
// bound on a table's header and delimiter rows (`hasLegalTableIndent`). Cell
// splitting is the shared `markdown-tables.ts` walk, whose backslash-run parity
// makes the escaped form this check tells authors to write the form it accepts.
//
// SCOPE BOUNDS — each measured over the 230 enforced files, not assumed, and
// each pinned by a test below so it stays a decision on record:
//   1. A table is RECOGNIZED only when its header line starts with `|`. GFM
//      also permits the outer pipes to be omitted entirely (`a | b` over
//      `--- | ---`); such a table is never visited. Zero instances in the
//      corpus (prettier writes outer pipes on every table it formats). Not
//      closed here because `isTableRow` is shared with table-total-coherence,
//      where widening it would change a required gate's table-boundary
//      detection. BODY rows are not subject to this — see below.
//   2. A table body ENDS at a pipe-less line. GFM would absorb such a line as
//      a lazy one-cell continuation row (the spec's own `bar` example), so a
//      pipe-less line abutting a table is a row this check does not compare.
//      Zero instances in the corpus. Closing it would need full block-start
//      classification (a heading, list item, or fence abutting a table is NOT
//      absorbed), which is out of proportion to a zero population.
//   3. An HTML comment closing mid-line suppresses the whole of that line, so
//      live markup in the TAIL after `-->` is not checked. Zero instances.

import { readFileSync } from "node:fs";

import {
  advanceFenceState,
  stripBlockquotePrefix,
  type OpenFenceState,
} from "./markdown-fences.ts";
import {
  containsUnescapedPipe,
  hasLegalTableIndent,
  isDelimiterRow,
  isTableRow,
  splitRow,
} from "./markdown-tables.ts";

export type TableArityViolationKind = "delimiter-arity" | "row-arity";

export interface TableArityViolation {
  file: string;
  /** 1-based line of the offending row. */
  line: number;
  /** 1-based line of the header row this arity is measured against. */
  headerLine: number;
  kind: TableArityViolationKind;
  /** Cell count of the header row. */
  expected: number;
  /** Cell count of the offending row. */
  actual: number;
  /** The offending row, truncated — enough to see the stray pipe. */
  excerpt: string;
}

const EXCERPT_LIMIT = 120;

function excerptOf(row: string): string {
  const trimmed = row.trim();
  return trimmed.length <= EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, EXCERPT_LIMIT)}…`;
}

/**
 * Does an HTML comment open on this line and stay open past its end?
 *
 * `lastIndexOf` so a line that closes one comment and opens another
 * (`<!-- a --> <!--`) is read by its FINAL state rather than its first.
 */
function opensUnclosedHtmlComment(line: string): boolean {
  const openIndex = line.lastIndexOf("<!--");
  if (openIndex === -1) return false;
  return line.indexOf("-->", openIndex + 4) === -1;
}

export function parseFile(filePath: string): TableArityViolation[] {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const violations: TableArityViolation[] = [];
  let openFence: OpenFenceState = null;
  let inHtmlComment = false;
  // The table currently being consumed, if any. Held as loop state rather than
  // walked by an inner loop so that fence and comment tracking advance over
  // EVERY line: body rows may now be pipe-bearing lines that are not table
  // rows, and one of those could itself be a fence opener (``` with a pipe in
  // its info string), which an index-skip would swallow and desynchronize.
  let openTable: { headerLine: number; expected: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const unquoted = stripBlockquotePrefix(lines[i]);

    // HTML comments first: their content is not markdown at all, so it must
    // not move fence state either. The line carrying `-->` is suppressed with
    // the rest (scope bound 3).
    if (inHtmlComment) {
      if (unquoted.includes("-->")) inHtmlComment = false;
      openTable = null;
      continue;
    }

    const { openFence: nextFence, isDelimiterLine } = advanceFenceState(unquoted, openFence);
    // The opener, the closer, and everything between are fence CONTENT: an
    // illustrative table inside ``` is prose about a table, not one.
    const fenceSuppressed = openFence !== null || isDelimiterLine;
    openFence = nextFence;
    if (fenceSuppressed) {
      openTable = null;
      continue;
    }

    // A comment that opens AND closes on one line never suppresses that line —
    // an inline `<!-- note -->` inside a real table row leaves the row live.
    if (opensUnclosedHtmlComment(unquoted)) inHtmlComment = true;

    if (openTable !== null) {
      // GFM makes the outer pipes optional, so the body continues over any
      // pipe-BEARING line, not only those with a leading `|`. It ends at a
      // blank line or a pipe-less one (scope bound 2).
      if (unquoted.trim() !== "" && containsUnescapedPipe(unquoted)) {
        const actual = splitRow(unquoted).length;
        if (actual !== openTable.expected) {
          violations.push({
            file: filePath,
            line: i + 1,
            headerLine: openTable.headerLine,
            kind: "row-arity",
            expected: openTable.expected,
            actual,
            excerpt: excerptOf(unquoted),
          });
        }
        continue;
      }
      openTable = null;
      // Fall through: this line may itself open a new table.
    }

    // A table starts at a row whose NEXT line is a delimiter row. Both must be
    // table rows (the delimiter test alone matches a horizontal rule `---`)
    // and both must clear the three-space indent bound, or the block is
    // indented code rather than a table (scope bound 1 covers the leading-pipe
    // requirement).
    if (!isTableRow(unquoted) || !hasLegalTableIndent(unquoted)) continue;
    if (i + 1 >= lines.length) continue;
    const delimiter = stripBlockquotePrefix(lines[i + 1]);
    if (!isTableRow(delimiter) || !isDelimiterRow(delimiter)) continue;
    if (!hasLegalTableIndent(delimiter)) continue;

    const expected = splitRow(unquoted).length;
    const headerLine = i + 1;

    const delimiterCells = splitRow(delimiter).length;
    if (delimiterCells !== expected) {
      violations.push({
        file: filePath,
        line: i + 2,
        headerLine,
        kind: "delimiter-arity",
        expected,
        actual: delimiterCells,
        excerpt: excerptOf(delimiter),
      });
    }

    openTable = { headerLine, expected };
    // Consume the delimiter row. Safe to skip without re-walking block state:
    // it matched `isDelimiterRow`, so it holds only pipes, dashes, colons and
    // spaces — it can be neither a fence delimiter nor an HTML comment.
    i++;
  }

  return violations;
}

export function checkTableArity(files: string[]): TableArityViolation[] {
  const violations: TableArityViolation[] = [];
  for (const file of files) {
    violations.push(...parseFile(file));
  }
  return violations;
}

export function formatTableArityViolations(violations: TableArityViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const violation of violations) {
    const what = violation.kind === "delimiter-arity" ? "delimiter row" : "row";
    // Name the rendered consequence, not just the arithmetic: the two kinds
    // fail very differently, and "off by one cell" reads as cosmetic until you
    // know the block stops being a table or the cell is dropped outright.
    const consequence =
      violation.kind === "delimiter-arity"
        ? "GFM does not recognize this block as a table at all — it renders as literal pipe text"
        : violation.actual > violation.expected
          ? "GFM ignores the excess cell — that content is silently dropped from the rendered table"
          : "GFM renders the missing cells as empty";
    lines.push(
      `table-arity: ${violation.file}:${violation.line} — ${what} has ${violation.actual} cell(s), ` +
        `header (line ${violation.headerLine}) has ${violation.expected}\n    ${violation.excerpt}\n    ${consequence}`,
    );
  }
  lines.push("");
  lines.push(
    `table-arity: ${violations.length} violation(s). A literal \`|\` splits cells even inside a code span — write \`\\|\` to keep it in the cell. ` +
      `Do NOT reconcile by widening the delimiter row: prettier will reflow the table around the stray pipe and every later format check passes on the corrupted result.`,
  );
  return lines.join("\n");
}
