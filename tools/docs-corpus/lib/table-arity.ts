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
// That last clause is four rules in the code, each failing CLOSED — declining
// to recognize rather than declining to report:
//   - a table opens only at a BLOCK BOUNDARY, so a header/delimiter pair inside
//     a paragraph or a raw-HTML block is never read as a table;
//   - a body line not confidently a row — blank, pipe-less, at another
//     blockquote depth, or starting a new block — CLOSES the table and is never
//     compared against its header;
//   - a delimiter row with any cell outside `:?-+:?` declines recognition
//     outright, rather than being measured for arity;
//   - a lone `|` header declines recognition: the one character cannot serve
//     as both outer pipes, and GFM renders the pair as prose.
// Three review rounds each returned a finding of the same shape: some context
// where a table-shaped line is not a table. These rules are the general answer
// to that shape, which is why the third round adds no new suppression list.
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
// apology for an unfinished parser. One of those rules has since been written
// by hand: the shared fence tracker models list containers, because a fence's
// indentation budget is meaningless without them (task #83). Table recognition
// does not consume that context — see bound 4 — and the argument above is
// unchanged for the rest of the sequence.
//
// SUPPRESSED — never read as live markup:
//   - fenced blocks, via the shared `markdown-fences.ts` tracker: an
//     illustrative table inside ``` is prose ABOUT a table, not one (which is
//     what lets the failure-mode catalog print the broken shape without the
//     gate failing on the documentation of itself);
//   - terminating raw-HTML blocks opened at BLOCK level — comment, processing
//     instruction, declaration, CDATA (CommonMark types 2-5), opener and
//     closer lines included: an HTML block interrupts what precedes it, its
//     content is not markdown, and all four forms span blank lines until
//     their closing sequence, so comparing the opener's own pipes would flag
//     a line GFM never renders as a row;
//   - leading YAML front matter, which is not markdown at all: 27 of the
//     enforced files carry it — 12 `.claude/agents/` definitions, 12 preflight
//     Gate-4 fixtures, 3 skill files — 0 with a pipe in the block today, and a
//     future `description: a | b` must not be read as a row. Closed at the
//     first BARE `---`/`...` fence; failing that, at the first fence carrying
//     a trailing YAML comment (`frontMatterEndIndex` holds the two-reading
//     union argument);
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
// rather than an unnoticed gap. All nine measure ZERO:
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
//      compare. The shapes GFM does NOT absorb — a heading, list item, HTML tag
//      or fence abutting a table — are classified rather than left to this
//      bound, so the residual is the lazy prose case alone.
//   3. (recall) A terminating raw-HTML block closing mid-line suppresses the
//      whole of that line, so live markup in the TAIL after its closer —
//      `-->`, `?>`, `>`, `]]>` — is not checked.
//   4. (recall) A header indented four or more spaces, or by a tab, is never
//      recognized, because `hasLegalTableIndent` measures from column zero.
//      The shared fence tracker now carries a list container stack (task #83),
//      so this is a decision rather than a structural limit: table recognition
//      deliberately does not consume that context, keeping one flat
//      indentation rule for the header, the delimiter, and every body row.
//      The residual splits two ways, both measured at zero over the 230
//      enforced files — 0 ENCLOSED (a table sitting within three spaces of a
//      list item's content column, which GFM does render and this declines)
//      and 0 ROOT (a table indented four-plus with no container, which is
//      indented code, where declining is simply correct).
//   5. (recall) A table opens only when its header and delimiter rows sit at
//      the SAME blockquote depth, and its body continues only at the header's
//      depth. A lazily-continued or depth-mixed quoted table is therefore not
//      compared. The guard is precision-safe in the other direction: ending a
//      table early can only lose findings, never invent them, whereas without
//      it a quoted header abutting an unquoted delimiter synthesizes a table
//      GFM never renders and then reports its "rows" (Codex, PR #269 round 2).
//   6. (precision — one of the two bounds in that direction) A terminating
//      raw-HTML block opened MID-LINE does not suppress its interior, because
//      entering suppression on an opener anywhere on a line let a code span
//      containing the literal characters `<!--` blank out the rest of a
//      document (Codex, PR #269 round 2). The interior is read as live markup.
//      Bound 7 narrows what that costs: the opener line is prose and so not a
//      boundary, which leaves a table shape on the FIRST interior line
//      unrecognized too — only one preceded by a blank line inside the block
//      is still exposed.
//   7. (recall) A header/delimiter pair is recognized only at a BLOCK BOUNDARY:
//      after a blank line, a heading, a fence or raw-HTML-block closer, table
//      machinery, or at the start of the scan. A pair anywhere else is not
//      compared — continuing a paragraph, inside a raw-HTML block, inside a
//      tight list, or directly beneath a single-line `<!-- … -->` comment (a
//      CommonMark type-2 block, which this classifier does not credit as a
//      boundary). Whether a table may interrupt a paragraph is contested — the
//      spec is silent and implementations diverge — so the check declines to
//      classify contested markup rather than adjudicating it (Codex, PR #269
//      round 3). Not every excluded shape is contested: CommonMark lets a
//      blockquote interrupt a paragraph, so a QUOTED pair directly under
//      unquoted prose is a plain recall miss — same zero measurement, and
//      pinned below.
//   8. (precision — the second) A CommonMark TYPE-1 HTML block (`pre`, `script`,
//      `style`, `textarea`) spans blank lines, while a blank line here opens a
//      boundary unconditionally, so a table shape after a blank line INSIDE such
//      a block would be recognized. Types 2-5 ARE tracked — each is a literal
//      opener/closer pair — but type 1 opens on a case-insensitive TAG-NAME set
//      and closes on any of four end tags, a different shape of state this
//      design declines to hold for a population of zero. Type-6 blocks (`<div>`
//      and friends) are unaffected: they END at a blank line, so reading what
//      follows as markdown is correct.
//   9. (recall) A pair whose delimiter row carries any cell outside `:?-+:?`
//      (`| --- | : |`) is not recognized, so neither that row nor the rows below
//      it are compared. GFM does not recognize it either, which is what makes
//      declining the honest answer: a malformed delimiter CELL goes unreported,
//      while a well-formed delimiter with the wrong cell COUNT — the Spec-015
//      class — is still the check's primary finding (Codex, PR #269 round 3).

import { readFileSync } from "node:fs";

import type { FileContentReader } from "./cite-target-existence.ts";
import {
  advanceFenceState,
  blockquoteDepth,
  INITIAL_SCAN_STATE,
  type MarkdownScanState,
  stripBlockquotePrefix,
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
 * The CommonMark raw-HTML block forms that TERMINATE on a closing sequence
 * rather than at a blank line: type 2 (comment), type 5 (CDATA), type 4
 * (declaration), type 3 (processing instruction). Each spans blank lines until
 * its closer appears, so tracking only the comment left a blank line inside
 * the other three re-opening a block boundary — and a table shape after it
 * read as live markup (Codex, PR #269 round 4). Types 6/7 are absent because
 * they END at a blank line, which the boundary rule already classifies
 * correctly; type 1 (`pre`/`script`/`style`/`textarea`) is bound 8.
 *
 * `opens` is tested against the trimmed line START (block level); `opener` is
 * the literal token the same-line-close scan anchors on. For the declaration
 * form that token is `<!` — the required ASCII letter is part of the start
 * condition, not of the token. The four start conditions are mutually
 * disjoint (`<!--` is `<!` + `-`, not a letter; `<![CDATA[` is `<!` + `[`),
 * so the array order carries no precedence.
 */
interface TerminatingHtmlBlockForm {
  opens(trimmedLine: string): boolean;
  opener: string;
  closer: string;
}

const TERMINATING_HTML_BLOCK_FORMS: TerminatingHtmlBlockForm[] = [
  { opens: (trimmedLine) => trimmedLine.startsWith("<!--"), opener: "<!--", closer: "-->" },
  {
    opens: (trimmedLine) => trimmedLine.startsWith("<![CDATA["),
    opener: "<![CDATA[",
    closer: "]]>",
  },
  { opens: (trimmedLine) => /^<![A-Za-z]/.test(trimmedLine), opener: "<!", closer: ">" },
  { opens: (trimmedLine) => trimmedLine.startsWith("<?"), opener: "<?", closer: "?>" },
];

/**
 * Does a terminating raw-HTML block open at BLOCK level on this line and stay
 * open past its end? Returns the closer to watch for, or null.
 *
 * Block-level is the whole point: the line's content must START with the
 * opener within CommonMark's three-space block bound (`hasLegalTableIndent`
 * is that bound — it is not table-specific). Scanning for `<!--` anywhere on
 * the line meant a code span holding the literal characters — `` `<!--` `` in
 * prose about HTML comments — opened comment state and suppressed every check
 * until the next `-->`, or the end of the file (Codex, PR #269 round 2). The
 * same rule now guards all four forms.
 *
 * `lastIndexOf` within that block-level line so one that closes a block and
 * opens another (`<!-- a --> <!--`) is read by its FINAL state, not its
 * first. The `opens` guard above is what makes that index non-negative — a
 * bare `lastIndexOf` with no found-check reports "opens a block" for every
 * line that contains none.
 */
function blockLevelTerminatingHtmlBlockCloser(line: string): string | null {
  if (!hasLegalTableIndent(line)) return null;
  const trimmedLine = line.trimStart();
  for (const form of TERMINATING_HTML_BLOCK_FORMS) {
    if (!form.opens(trimmedLine)) continue;
    const openIndex = line.lastIndexOf(form.opener);
    return line.indexOf(form.closer, openIndex + form.opener.length) === -1 ? form.closer : null;
  }
  return null;
}

/**
 * A closing fence carrying a trailing YAML comment: `--- # end`, `... # done`.
 * YAML requires whitespace before a `#` comment, so the glued `---#x` is not a
 * marker-plus-comment in any reading and stays content.
 */
const CONTESTED_FRONT_MATTER_CLOSER_PATTERN = /^(?:---|\.\.\.)[ \t]+#/;

/**
 * Index of the line that CLOSES leading YAML front matter, or -1 when the file
 * has none — so the scan starts at `frontMatterEndIndex(lines) + 1` either way.
 *
 * Front matter exists only at the very start of a file: line 1 must be the
 * opening `---`, and a `---` anywhere else is a thematic break. It ends at the
 * first following BARE fence — `---` or `...`, both YAML document terminators.
 * An UNTERMINATED opener is not front matter at all — a closing fence is
 * required for the block to exist — so the file is scanned from line 1 as
 * ordinary content rather than silently swallowed whole.
 *
 * A fence carrying a trailing YAML comment (`--- # end`) is CONTESTED markup:
 * bare-fence hosts (Jekyll's `^(---|\.\.\.)\s*$`, Hugo, gray-matter's
 * delimiter match) do not close on it, while YAML's own document-marker
 * grammar does — as does this repo's operative front-matter consumer,
 * preflight's `parseFrontmatter`
 * (.claude/skills/plan-execution/scripts/preflight.mjs), which closes on any
 * following line that merely STARTS with `---`. So the fence tiers rather
 * than adjudicating: the first bare fence closes whenever one exists anywhere
 * below; only when none does, the first comment-carrying fence closes (Codex,
 * PR #269 round 4). That is the UNION of the two readings' front-matter
 * extents — under either authority every line that authority calls front
 * matter is suppressed, so a divergent closer can cost recall on the
 * contested region but never a false positive. The residual is the
 * prefix-only closer shape the bare-fence hosts and YAML BOTH reject
 * (`---suffix`, `----`), credited by nothing here — measured zero.
 *
 * Fences are matched after `trimEnd()`, which tolerates a CRLF file's
 * trailing `\r` (content is split on `\n`) and stray trailing spaces. Leading
 * whitespace is NOT tolerated on any fence: an indented `---` is not a front
 * matter delimiter, and accepting one would extend the suppression.
 */
function frontMatterEndIndex(lines: string[]): number {
  if (lines.length === 0 || lines[0].trimEnd() !== "---") return -1;
  let contestedCloserIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index].trimEnd();
    if (trimmed === "---" || trimmed === "...") return index;
    if (contestedCloserIndex === -1 && CONTESTED_FRONT_MATTER_CLOSER_PATTERN.test(trimmed)) {
      contestedCloserIndex = index;
    }
  }
  return contestedCloserIndex;
}

/** ATX heading, within CommonMark's three-space block bound: `# x` … `###### x`. */
const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** List item marker, bullet or ordered: `- x`, `* x`, `1. x`, `9999.) x`. */
const LIST_MARKER_PATTERN = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/;
/** A line opening with an HTML tag — the shape CommonMark reads as a block start. */
const HTML_TAG_LINE_PATTERN = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t/>]|$)/;

/**
 * Does a new block-level structure begin on this line?
 *
 * GFM ends a table "at the first empty line, or beginning of another
 * block-level structure", so a pipe-bearing heading, list item, or HTML tag
 * abutting a table body is the NEXT block and never a row of the previous one.
 * Comparing its cell count reports a row GFM does not render — a false positive
 * on valid documentation, which is the direction this check must not fail in.
 *
 * Enumerated rather than exhaustive: these are the three shapes that can carry a
 * pipe and still start a block. A table body ending early can only lose
 * findings, never invent them, so an omission here stays on the recall side.
 */
function startsBlockLevelStructure(line: string): boolean {
  return (
    ATX_HEADING_PATTERN.test(line) ||
    LIST_MARKER_PATTERN.test(line) ||
    HTML_TAG_LINE_PATTERN.test(line)
  );
}

/**
 * Does this line leave the NEXT one at a BLOCK BOUNDARY — a position where GFM
 * would let a new block, and so a table header, begin?
 *
 * A blank line closes whatever was open and a heading is a one-line block, so
 * both leave the next line free. Everything else — prose, an HTML tag, a list
 * marker, a pipe-bearing line that opened no table — leaves the next line INSIDE
 * something, where a header/delimiter pair is that block's content rather than a
 * table (bound 7).
 *
 * This is what keeps the check out of paragraph interiors and raw-HTML blocks
 * without modelling either, and two shapes raised independently collapse into
 * it. A paragraph line followed by a header/delimiter pair is contested markup:
 * the spec is silent on whether a table may interrupt a paragraph and
 * implementations diverge, so the check declines to classify it rather than
 * adjudicating the question. A table drawn inside `<div>` is raw HTML, excluded
 * because the tag line is a non-boundary — no HTML state machine involved. A
 * blank line both ENDS a CommonMark type-6 HTML block and opens a boundary, so
 * `<div>`, blank, table is still recognized, which is right: there the table is
 * markdown again.
 */
function leavesBlockBoundary(line: string): boolean {
  return line.trim() === "" || ATX_HEADING_PATTERN.test(line);
}

/** A GFM delimiter CELL: hyphens, with an optional leading and/or trailing colon. */
const DELIMITER_CELL_PATTERN = /^:?-+:?$/;

/**
 * Is every cell of this delimiter row a legal alignment spec?
 *
 * `isDelimiterRow` asks only that the line hold a dash and nothing outside
 * pipes, whitespace, colons and dashes — which `| --- | : |` satisfies while GFM
 * rejects it, the delimiter row consisting of "cells whose only content are
 * hyphens and optionally, a leading or trailing colon, or both". The check is
 * local to this module because `isDelimiterRow` is shared with
 * table-total-coherence, where narrowing it would change a required gate's
 * table-boundary detection.
 *
 * A pair GFM does not recognize is not a table, so this DECLINES rather than
 * reporting an arity — which is why it runs before the delimiter-arity
 * comparison: a malformed cell means no table, and no table means nothing to
 * measure (bound 9).
 *
 * It SUBSUMES `isDelimiterRow`: every cell matching the cell grammar forces at
 * least one dash and nothing outside dashes, colons, pipes and whitespace, so
 * nothing reaches here that the shared predicate would reject. That predicate
 * stays the first gate deliberately — it is this corpus's shared vocabulary for
 * "delimiter row", shared with table-total-coherence, and reading the guard
 * without it would leave the two checks looking like they disagree about what
 * one is. The redundancy is why the mutation arm for the shared predicate
 * deletes both gates rather than one.
 */
function hasOnlyValidDelimiterCells(delimiter: string): boolean {
  const cells = splitRow(delimiter);
  if (cells.length === 0) return false;
  return cells.every((cell) => DELIMITER_CELL_PATTERN.test(cell.trim()));
}

export function parseFile(
  filePath: string,
  readContent: FileContentReader = readFromDisk,
): TableArityViolation[] {
  const lines = readContent(filePath).split("\n");
  const violations: TableArityViolation[] = [];
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  // The closer of the terminating raw-HTML block currently open, if any —
  // `-->`, `?>`, `>` or `]]>` per TERMINATING_HTML_BLOCK_FORMS.
  let openHtmlBlockCloser: string | null = null;
  // The table currently being consumed, if any. Held as loop state rather than
  // walked by an inner loop so that fence and comment tracking advance over
  // EVERY line: body rows may be pipe-bearing lines that are not table rows,
  // and one of those could itself be a fence opener (``` with a pipe in its
  // info string), which an index-skip would swallow and desynchronize.
  let openTable: { headerLine: number; expected: number; depth: number } | null = null;
  // Is the line about to be read at a block boundary? A header/delimiter pair is
  // recognized only there (bound 7), which is the single rule that replaced a
  // growing list of per-context suppressions. True at the start: the first
  // content line of a file — or the first after front matter, which is not
  // markdown and leaves nothing open — begins a block.
  let atBlockBoundary = true;

  for (let i = frontMatterEndIndex(lines) + 1; i < lines.length; i++) {
    const unquoted = stripBlockquotePrefix(lines[i]);
    // GFM builds a table only from rows in the same container. Depth is the
    // count of BLOCKQUOTE markers the shared strip consumes — not a stack of
    // them, which is the path this check declines to walk (bound 5). The
    // shared tracker does carry a LIST container stack, but only to place a
    // fence delimiter's indentation budget; table recognition stays on the
    // flat root-relative rule (bound 4).
    const depth = blockquoteDepth(lines[i]);

    // Terminating raw-HTML blocks first: their content is not markdown at
    // all, so it must not move fence state either. The line carrying the
    // closer is suppressed with the rest (bound 3).
    if (openHtmlBlockCloser !== null) {
      if (unquoted.includes(openHtmlBlockCloser)) openHtmlBlockCloser = null;
      openTable = null;
      atBlockBoundary = true;
      continue;
    }

    const { state: nextScanState, isDelimiterLine } = advanceFenceState(unquoted, scanState);
    // The opener, the closer, and everything between are fence CONTENT: an
    // illustrative table inside ``` is prose about a table, not one.
    const fenceSuppressed = scanState.openFence !== null || isDelimiterLine;
    scanState = nextScanState;
    if (fenceSuppressed) {
      openTable = null;
      atBlockBoundary = true;
      continue;
    }

    // An HTML block interrupts whatever precedes it, so the OPENER line ends
    // any open table and is itself suppressed — symmetric with the closer
    // above. Comparing it would flag the pipes in `<!-- | x | y | z |` as a
    // row GFM does not render. A block that opens AND closes on one line is
    // not entered: an inline `<!-- note -->` inside a real table row leaves
    // that row live.
    // Every suppressed line above leaves a boundary behind it: a fence and a
    // block-level terminating HTML block both END on their closer, so the line
    // after one begins a new block. A table abutting a closing ``` or `-->` with
    // no blank line between is therefore still recognized.
    const closerOfOpenedBlock = blockLevelTerminatingHtmlBlockCloser(unquoted);
    if (closerOfOpenedBlock !== null) {
      openHtmlBlockCloser = closerOfOpenedBlock;
      openTable = null;
      atBlockBoundary = true;
      continue;
    }

    if (openTable !== null) {
      // GFM makes the outer pipes optional, so the body continues over any
      // pipe-BEARING line at the header's depth, not only those with a leading
      // `|`. It ends at a blank line, a pipe-less one (bound 2), a change of
      // blockquote depth (bound 5), or the start of another block-level
      // structure — the last of these tested BEFORE the comparison, so a heading
      // or list item that happens to carry a pipe closes the table instead of
      // being reported as a malformed row of it.
      if (
        depth === openTable.depth &&
        unquoted.trim() !== "" &&
        containsUnescapedPipe(unquoted) &&
        !startsBlockLevelStructure(unquoted)
      ) {
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
        // Restating the invariant rather than establishing it: the flag is
        // already true for every line of a recognized table, set when the pair
        // opened. Kept so the transition is stated wherever a line is consumed.
        atBlockBoundary = true;
        continue;
      }
      openTable = null;
      // Fall through: this line takes its own classification below and may
      // itself open a new table, at its own depth.
    }

    // Classify this line for the next iteration BEFORE the recognition guards
    // start returning: a line that fails any of them is ordinary content and
    // leaves no boundary behind it. Opening a table overrides this to true.
    const mayOpenTable = atBlockBoundary;
    atBlockBoundary = leavesBlockBoundary(unquoted);

    // A table starts at a row whose NEXT line is a delimiter row, and only at a
    // block boundary (bound 7). Both rows must be table rows (the delimiter test
    // alone matches a horizontal rule `---`), both must clear the three-space
    // indent bound or the block is indented code rather than a table (bounds 1
    // and 4), both must sit at the same blockquote depth (bound 5), and every
    // delimiter cell must be a legal alignment spec (bound 9).
    if (!mayOpenTable) continue;
    if (!isTableRow(unquoted) || !hasLegalTableIndent(unquoted)) continue;
    // A lone `|` delimits no cell: the one character cannot serve as BOTH the
    // leading and the trailing outer pipe, yet the shared splitter strips it
    // twice and mints one empty cell — the same count as `||` — so a `|`
    // header over a `|-|` delimiter opened a synthetic table and reported an
    // arity on markup GitHub renders as a paragraph (Codex, PR #269 round 4).
    // A guard, not a disclosed bound: GFM recognizes no table here either, so
    // the decline excludes nothing GFM renders — while `||` and `| |` DO open
    // a real one-column table and stay recognized. Local to the open path
    // because the splitter is shared with table-total-coherence; header-side
    // only because the delimiter side already declines (`|` holds no dash).
    if (unquoted.trim() === "|") continue;
    if (i + 1 >= lines.length) continue;
    const delimiter = stripBlockquotePrefix(lines[i + 1]);
    if (!isTableRow(delimiter) || !isDelimiterRow(delimiter)) continue;
    if (!hasLegalTableIndent(delimiter)) continue;
    if (blockquoteDepth(lines[i + 1]) !== depth) continue;
    if (!hasOnlyValidDelimiterCells(delimiter)) continue;

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
    // Header and delimiter are both table machinery, so the pair leaves the
    // first body candidate at a boundary.
    atBlockBoundary = true;
    // Consume the delimiter row. Safe to skip without re-walking block state:
    // it matched `isDelimiterRow`, so it holds only pipes, dashes, colons and
    // spaces — it can be neither a fence delimiter nor a raw-HTML opener.
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
  lines.push(`table-arity: ${violations.length} violation(s).`);
  // The remedy is direction-specific and the two directions are OPPOSITES, so
  // the guidance is keyed on direction rather than on kind. A row wider than its
  // header is a stray pipe to escape, and widening the delimiter to match is
  // exactly what made the Spec-015 typo permanent. A row narrower than its
  // header is a missing cell — and when the short row IS the delimiter, widening
  // it is the correct repair. One unconditional trailer told that second case
  // never to do the only thing that fixes it.
  if (violations.some((violation) => violation.actual > violation.expected)) {
    lines.push(
      `  WIDER than the header: a literal \`|\` splits cells even inside a code span — write \`\\|\` to keep it in the cell. ` +
        `Do NOT reconcile by widening the delimiter row: prettier will reflow the table around the stray pipe and every later format check passes on the corrupted result.`,
    );
  }
  if (violations.some((violation) => violation.actual < violation.expected)) {
    lines.push(
      `  NARROWER than the header: add the missing cell(s) to match the header. ` +
        `Where the short row is the delimiter, that means widening it — the opposite of the case above, and the right move here: until header and delimiter agree on the count, GFM renders no table at all.`,
    );
  }
  return lines.join("\n");
}
