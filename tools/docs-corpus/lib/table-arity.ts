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
//
// What the two violation kinds cost, per the GFM tables extension
// (https://github.github.com/gfm/#tables-extension-, fetched 2026-07-28):
//   - delimiter vs header mismatch — "The header row must match the delimiter
//     row in the number of cells. If not, a table will not be recognized." The
//     block stops being a table outright and renders as a paragraph of literal
//     pipe text. This is the live state of the Spec-015 matrix below.
//   - body row WIDER than the header — "If there are greater, the excess is
//     ignored." The surplus cell is dropped from the rendered output, so the
//     failure is silent content LOSS rather than a visible mess.
//   - body row NARROWER — missing cells render empty; benign, and flagged only
//     because it is the same authoring slip seen from the other side.
//   - docs/specs/015 §Clock-Skew Detection — `<env | file>` widened a 3-column
//     row to 4 and the delimiter row was "repaired" to 4 dashes to match.
//   - failure-mode-catalog CAT-10 (PR #267) — an unescaped `|| true` in a
//     2-column row, caught only by a human reading the commit.
//
// The invariant is deliberately WITHIN-table: rows are compared to their own
// header, never to intent. A table whose header is itself wrong passes cleanly
// — this finds rows that disagree with their header, not headers that disagree
// with the author. That bound is what keeps the check free of judgment calls,
// and the corruption class it targets always manifests as a disagreement.
//
// SCOPE BOUND, measured not assumed: a table is recognized only when its header
// line starts with `|`. GFM also permits outer pipes to be omitted entirely
// (`a | b` over `--- | ---`), and such a table is invisible here — it is never
// visited, so its rows are never compared. The enforced corpus was probed for
// that shape at 230 files and contains zero of them (prettier writes outer
// pipes on every table it formats), and the probe was itself verified against a
// synthetic instance so the zero is a measurement rather than a broken query.
// The bound is disclosed instead of closed because `isTableRow` is shared with
// table-total-coherence, where widening it would change a required gate's
// table-boundary detection — a behavior change that does not belong in this
// PR. `parseFile` is pinned against that shape below so the limit is a decision
// on record, not an unnoticed hole.
//
// Fence-aware via the shared tracker (`markdown-fences.ts`), so a table drawn
// inside a ``` block as an EXAMPLE — including a deliberately-malformed one
// used to document this very failure — is content, not a table. Cell splitting
// is the shared `markdown-tables.ts` walk, which consumes `\|` as content, so
// the escaped form this check tells authors to write is the form it accepts.

import { readFileSync } from "node:fs";

import {
  advanceFenceState,
  stripBlockquotePrefix,
  type OpenFenceState,
} from "./markdown-fences.ts";
import { isDelimiterRow, isTableRow, splitRow } from "./markdown-tables.ts";

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

export function parseFile(filePath: string): TableArityViolation[] {
  const lines = readFileSync(filePath, "utf8").split("\n");
  const violations: TableArityViolation[] = [];
  let openFence: OpenFenceState = null;

  for (let i = 0; i < lines.length; i++) {
    const unquoted = stripBlockquotePrefix(lines[i]);
    const { openFence: nextFence, isDelimiterLine } = advanceFenceState(unquoted, openFence);
    // The opener, the closer, and everything between are fence CONTENT: an
    // illustrative table inside ``` is prose about a table, not one.
    const suppressed = openFence !== null || isDelimiterLine;
    openFence = nextFence;
    if (suppressed) continue;

    // A table starts at a row whose NEXT line is a delimiter row. Both must be
    // table rows: the delimiter test alone matches a horizontal rule (`---`).
    if (!isTableRow(unquoted)) continue;
    if (i + 1 >= lines.length) continue;
    const delimiter = stripBlockquotePrefix(lines[i + 1]);
    if (!isTableRow(delimiter) || !isDelimiterRow(delimiter)) continue;

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

    let end = i + 2;
    for (; end < lines.length; end++) {
      const body = stripBlockquotePrefix(lines[end]);
      if (!isTableRow(body)) break;
      const actual = splitRow(body).length;
      if (actual !== expected) {
        violations.push({
          file: filePath,
          line: end + 1,
          headerLine,
          kind: "row-arity",
          expected,
          actual,
          excerpt: excerptOf(body),
        });
      }
    }

    // Resume after the table. Safe for fence state without re-walking: every
    // line consumed here is a table row (leading `|`), and `advanceFenceState`
    // only ever transitions on a line whose first non-space character is a
    // backtick or tilde run — so none of them could have moved it.
    i = end - 1;
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
