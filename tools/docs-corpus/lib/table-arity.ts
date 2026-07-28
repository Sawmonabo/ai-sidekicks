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
// ── RECOGNITION CONTRACT ────────────────────────────────────────────────────
//
// This check recognizes a CONSERVATIVE SUBSET of GFM tables. It is not a
// markdown parser and is not on its way to becoming one: block classification
// is a fixed, enumerated set of rules, every table GFM recognizes that the
// subset excludes is a disclosed and MEASURED bound, and the gate never fails
// on markup it cannot confidently classify.
//
// The asymmetry is what makes a subset the right design rather than a shortcut.
// A false positive fails a REQUIRED gate on valid documentation, and the
// author's only recourse is to mangle correct markup to appease it. A false
// negative misses one instance of a class whose two known real instances were
// both plain, top-level, prettier-formatted tables — the shape the subset
// covers exactly. Review rounds 1 and 2 each proposed another context rule
// (fences, HTML comments, indented code, code-span openers, list containers,
// front matter, blockquote depth); the general case of that sequence is a real
// GFM parser, and no parser package (micromark, mdast, remark, unified) exists
// anywhere in this repo's dependency tree. Taking a production dependency to
// close gaps that all measure ZERO would be the disproportionate move. So the
// bounds below are the design's edge, drawn deliberately and measured — not an
// apology for an unfinished parser.
//
// SUPPRESSED — never read as live markup:
//   - fenced blocks, via the shared `markdown-fences.ts` tracker: an
//     illustrative table inside ``` is prose ABOUT a table, not one (which is
//     what lets the failure-mode catalog print the broken shape without the
//     gate failing on the documentation of itself);
//   - HTML comments opened at BLOCK level, opener and closer lines included —
//     an HTML block interrupts what precedes it and its content is not
//     markdown, so comparing the opener's own pipes would flag a line GFM never
//     renders as a row;
//   - leading YAML front matter, which is not markdown at all: 27 of the
//     enforced files carry it — 12 `.claude/agents/` definitions, 12 preflight
//     Gate-4 fixtures, 3 skill files — 0 with a pipe in the block today, and a
//     future `description: a | b` must not be read as a row;
//   - indented code, via CommonMark's three-space block bound on a table's
//     header and delimiter rows (`hasLegalTableIndent`).
// Cell splitting is the shared `markdown-tables.ts` walk, whose backslash-run
// parity makes the escaped form this check tells authors to write the form it
// accepts. Content arrives through an injected reader so the runner validates
// the COMMIT (the git index) rather than the editor buffer; the default reads
// from disk, which is what the tests and ad-hoc probes want.
//
// WITHIN-TABLE by design: rows are compared to their own header, never to
// intent. A table whose header is itself wrong passes cleanly — this finds rows
// that disagree with their header, not headers that disagree with the author.
// That bound is what keeps the check free of judgment calls, and the corruption
// class it targets always manifests as a disagreement.
//
// DISCLOSED BOUNDS — the subset's edge. Each is measured over the 230 enforced
// `.md` files with a predicate proven to fire on a synthetic positive in the
// same run, and each is pinned by a test below so it stays a decision on record
// rather than an unnoticed gap. All six measure ZERO:
//   1. (recall) A table is RECOGNIZED only when its header line starts with
//      `|`. GFM also permits the outer pipes to be omitted entirely (`a | b`
//      over `--- | ---`); such a table is never visited. Prettier writes outer
//      pipes on every table it formats, which is why the population is empty.
//      Not closed here because `isTableRow` is shared with
//      table-total-coherence, where widening it would change a required gate's
//      table-boundary detection. BODY rows are not subject to this.
//   2. (recall) A table body ENDS at a pipe-less line. GFM would absorb such a
//      line as a lazy one-cell continuation row (the spec's own `bar` example),
//      so a pipe-less line abutting a table is a row this check does not
//      compare. Closing it needs full block-start classification — a heading,
//      list item, or fence abutting a table is NOT absorbed.
//   3. (recall) An HTML comment closing mid-line suppresses the whole of that
//      line, so live markup in the TAIL after `-->` is not checked.
//   4. (recall) A header indented four or more spaces, or by a tab, is never
//      recognized. This is the superset of the list-container case (a table
//      nested under a list item carries that indentation), and taking it as one
//      indentation rule is what avoids tracking container stacks.
//   5. (recall) A table opens only when its header and delimiter rows sit at
//      the SAME blockquote depth, and its body continues only at the header's
//      depth. A lazily-continued or depth-mixed quoted table is therefore not
//      compared. The guard is precision-safe in the other direction: ending a
//      table early can only lose findings, never invent them, whereas without
//      it a quoted header abutting an unquoted delimiter synthesizes a table
//      GFM never renders and then reports its "rows" (Codex, PR #269 round 2).
//   6. (precision — the one bound in the other direction) An HTML comment
//      opened MID-LINE does not suppress its interior, because entering comment
//      state on any `<!--` anywhere on a line let a code span containing the
//      literal characters `<!--` blank out the rest of a document (Codex,
//      PR #269 round 2). The interior of such a comment is now read as live
//      markup, so a malformed table drawn inside one would be flagged.

import { readFileSync } from "node:fs";

import type { FileContentReader } from "./cite-target-existence.ts";
import {
  advanceFenceState,
  blockquoteDepth,
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

const readFromDisk: FileContentReader = (absolutePath) => readFileSync(absolutePath, "utf8");

/**
 * Does a BLOCK-LEVEL HTML comment open on this line and stay open past its end?
 *
 * Block-level is the whole point: the line's content must START with `<!--`
 * within CommonMark's three-space block bound (`hasLegalTableIndent` is that
 * bound — it is not table-specific). Scanning for `<!--` anywhere on the line
 * meant a code span holding the literal characters — `` `<!--` `` in prose
 * about HTML comments — opened comment state and suppressed every check until
 * the next `-->`, or the end of the file (Codex, PR #269 round 2).
 *
 * `lastIndexOf` within that block-level line so one that closes a comment and
 * opens another (`<!-- a --> <!--`) is read by its FINAL state, not its first.
 * The `startsWith` guard above is what makes that index non-negative — a bare
 * `lastIndexOf` with no found-check reports "opens a comment" for every line
 * that contains none.
 */
function opensBlockLevelHtmlComment(line: string): boolean {
  if (!hasLegalTableIndent(line)) return false;
  if (!line.trimStart().startsWith("<!--")) return false;
  const openIndex = line.lastIndexOf("<!--");
  return line.indexOf("-->", openIndex + 4) === -1;
}

/**
 * Index of the line that CLOSES leading YAML front matter, or -1 when the file
 * has none — so the scan starts at `frontMatterEndIndex(lines) + 1` either way.
 *
 * Front matter exists only at the very start of a file: line 1 must be the
 * opening `---`, and a `---` anywhere else is a thematic break. It ends at the
 * first following line that is `---` or `...`, both of which YAML accepts as
 * document terminators. An UNTERMINATED opener is not front matter at all — a
 * closing fence is required for the block to exist — so the file is scanned
 * from line 1 as ordinary content rather than silently swallowed whole.
 *
 * Both fences are matched after `trimEnd()`, which tolerates a CRLF file's
 * trailing `\r` (content is split on `\n`) and stray trailing spaces. Leading
 * whitespace is NOT tolerated on either fence: an indented `---` is not a front
 * matter delimiter, and accepting one would extend the suppression.
 */
function frontMatterEndIndex(lines: string[]): number {
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return -1;
  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index].trimEnd();
    if (trimmed === "---" || trimmed === "...") return index;
  }
  return -1;
}

export function parseFile(
  filePath: string,
  readContent: FileContentReader = readFromDisk,
): TableArityViolation[] {
  const lines = readContent(filePath).split("\n");
  const violations: TableArityViolation[] = [];
  let openFence: OpenFenceState = null;
  let inHtmlComment = false;
  // The table currently being consumed, if any. Held as loop state rather than
  // walked by an inner loop so that fence and comment tracking advance over
  // EVERY line: body rows may be pipe-bearing lines that are not table rows,
  // and one of those could itself be a fence opener (``` with a pipe in its
  // info string), which an index-skip would swallow and desynchronize.
  let openTable: { headerLine: number; expected: number; depth: number } | null = null;

  for (let i = frontMatterEndIndex(lines) + 1; i < lines.length; i++) {
    const unquoted = stripBlockquotePrefix(lines[i]);
    // GFM builds a table only from rows in the same container. Depth is the
    // count of markers the shared strip consumes — NOT a container stack, which
    // is the unbounded path this check declines to walk (bound 5).
    const depth = blockquoteDepth(lines[i]);

    // HTML comments first: their content is not markdown at all, so it must
    // not move fence state either. The line carrying `-->` is suppressed with
    // the rest (bound 3).
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

    // An HTML block interrupts whatever precedes it, so the OPENER line ends
    // any open table and is itself suppressed — symmetric with the closer
    // above. Comparing it would flag the pipes in `<!-- | x | y | z |` as a
    // row GFM does not render. A comment that opens AND closes on one line is
    // not an HTML block: an inline `<!-- note -->` inside a real table row
    // leaves that row live.
    if (opensBlockLevelHtmlComment(unquoted)) {
      inHtmlComment = true;
      openTable = null;
      continue;
    }

    if (openTable !== null) {
      // GFM makes the outer pipes optional, so the body continues over any
      // pipe-BEARING line at the header's depth, not only those with a leading
      // `|`. It ends at a blank line, a pipe-less one (bound 2), or a change of
      // blockquote depth (bound 5).
      if (depth === openTable.depth && unquoted.trim() !== "" && containsUnescapedPipe(unquoted)) {
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
      // Fall through: this line may itself open a new table, at its own depth.
    }

    // A table starts at a row whose NEXT line is a delimiter row. Both must be
    // table rows (the delimiter test alone matches a horizontal rule `---`),
    // both must clear the three-space indent bound or the block is indented
    // code rather than a table (bounds 1 and 4), and both must sit at the same
    // blockquote depth (bound 5).
    if (!isTableRow(unquoted) || !hasLegalTableIndent(unquoted)) continue;
    if (i + 1 >= lines.length) continue;
    const delimiter = stripBlockquotePrefix(lines[i + 1]);
    if (!isTableRow(delimiter) || !isDelimiterRow(delimiter)) continue;
    if (!hasLegalTableIndent(delimiter)) continue;
    if (blockquoteDepth(lines[i + 1]) !== depth) continue;

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

    openTable = { headerLine, expected, depth };
    // Consume the delimiter row. Safe to skip without re-walking block state:
    // it matched `isDelimiterRow`, so it holds only pipes, dashes, colons and
    // spaces — it can be neither a fence delimiter nor an HTML comment.
    i++;
  }

  return violations;
}

export function checkTableArity(
  files: string[],
  readContent: FileContentReader = readFromDisk,
): TableArityViolation[] {
  const violations: TableArityViolation[] = [];
  for (const file of files) {
    violations.push(...parseFile(file, readContent));
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
