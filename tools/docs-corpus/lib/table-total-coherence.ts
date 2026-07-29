// table-total-coherence — arithmetic guard for opt-in "total row" tables.
//
// Closes the F-4 gap from the PR #152 retrospective: a census / breakdown table
// that declares a column total ("130 event types") can silently drift from the
// sum of its own column. PR #152 shipped a census summary whose declared total
// disagreed with the sum of its own category column — a mechanically computable
// invariant that no gate re-computed. This check re-sums the marked column and
// compares it
// against EVERY total assertion bound to the table: the in-table `**Total**` row
// AND any prose `<label>: **N**` line the marker declares. A check that compared
// only the in-table Total row to the column would have PASSED round 19's defect
// (the prose, not the Total row, was the drifting assertion) — so both are
// reconciled.
//
// Opt-in by marker so it never false-positives on capacity / metric tables whose
// rows are independent figures (e.g. `deployment-topology.md` "Total
// participants | 5,000" — a scale target, not a column sum). Such tables carry
// no marker and are never linted.
//
// Trigger: an HTML comment marker immediately preceding a GFM table (on its own
// line, or trailing a prose line — the next non-blank line must be the table):
//   <!-- corpus:total-check column="Count" prose-total="Total enumerated event types" -->
//
//   - column      (required): header text of the column whose data rows are summed.
//   - prose-total (optional, repeatable): label of a prose total assertion
//     elsewhere in the SAME document that must also equal the sum. Two phrasings
//     resolve: the colon form `<label>: N` (number after the label, e.g. "Total
//     enumerated event types: **130**") and the prefix form `N-<label>` (number
//     before the label, e.g. "**130-event type registry**"). Bold/code wrappers
//     are stripped before matching.
//
// Within-document only. Cross-document agreement (Spec-006's 130 vs Plan-006's
// 130) is the audit runbook's synthesis-stage Cross-Document Design-Fact
// Reciprocity dimension, not this lint — a cross-doc registry here would be the
// over-engineering trap. See
// docs/operations/plan-implementation-readiness-audit-runbook.md.
//
// Fails LOUD — a violation, never a silent skip — when a marker is malformed:
// missing/unknown column, no Total row, an unresolved prose-total label, no
// table after the marker, or a non-numeric data cell in the summed column. A
// silently-skipped marker is the vacuous-pass failure the runbook's own
// byte-identity lesson warns against.
//
// Content arrives through an injected FileContentReader (defaulting to a plain
// disk read): the pre-commit runner passes its commit-snapshot reader so the
// check validates the STAGED blob, while the standalone G7 bin keeps the disk
// default — its inputs are pre-swap working copies that exist only on disk
// (see ../bin/table-total-check.ts).

import { readFileSync } from "node:fs";

import type { FileContentReader } from "./cite-target-existence.ts";
import { advanceScanState, INITIAL_SCAN_STATE, type MarkdownScanState } from "./markdown-fences.ts";
import { isDelimiterRow, isTableRow, splitRow } from "./markdown-tables.ts";

export type TableTotalViolationKind =
  | "total-row-mismatch"
  | "prose-total-mismatch"
  | "missing-column-attr"
  | "unknown-column"
  | "no-total-row"
  | "no-table-after-marker"
  | "prose-total-not-found"
  | "non-numeric-cell";

export interface TableTotalViolation {
  file: string;
  line: number; // 1-based line of the marker
  column: string; // declared column ("" when the marker omits it)
  kind: TableTotalViolationKind;
  /** Computed sum of the column's data rows (present for the arithmetic kinds). */
  sum?: number;
  /** The asserted total that disagrees with `sum` (present for the mismatch kinds). */
  asserted?: number;
  /** Human-facing locator: the prose label, the offending cell text, etc. */
  detail?: string;
}

const MARKER_RE = /<!--\s*corpus:total-check\b([^>]*?)-->/;

const readFromDisk: FileContentReader = (absolutePath) => readFileSync(absolutePath, "utf8");

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip bold/code wrappers and trim — the normalization applied to every cell. */
function stripCell(cell: string): string {
  return cell.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/** Parse an integer from a cell, tolerating bold, code, and thousands separators. */
function parseCellNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const cleaned = stripCell(cell).replace(/,/g, "");
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 10);
}

export function parseFile(
  filePath: string,
  readContent: FileContentReader = readFromDisk,
): TableTotalViolation[] {
  const content = readContent(filePath);
  const lines = content.split("\n");
  const violations: TableTotalViolation[] = [];

  // Pre-scan: which lines sit inside a fenced code block. Markers shown as
  // examples inside ```/~~~ fences (e.g. this convention documented in the audit
  // runbook) are NOT live markers and must be skipped. State comes from the
  // shared tracker: the private toggle this replaces closed a fence on ANY
  // same-marker line, so an info-string'd inner delimiter ended suppression
  // early and a documented example marker below it went live; it also opened
  // fences on indented code (4+ spaces) and never looked through blockquote
  // containers. Both delimiter lines count as fenced — the toggle marked opener
  // and closer alike, and a marker ON a delimiter line is fence punctuation,
  // not a live marker. The tracker measures the fence budget from the
  // enclosing list item's content column, so a marker inside an example fence
  // nested under a `10. ` item is inert like any other (task #83; through PR
  // #270 that delimiter read as indented code and the marker below it went
  // LIVE — fail-closed, and measured absent from the tracked corpus).
  const fenced = new Array<boolean>(lines.length).fill(false);
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  for (let i = 0; i < lines.length; i++) {
    const stepped = advanceScanState(lines[i], scanState);
    fenced[i] = stepped.openFenceAtLineStart !== null || stepped.isDelimiterLine;
    scanState = stepped.state;
  }

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    // A marker printed as inline-code documentation — e.g. the failure-mode
    // catalog's CAT-09 row, which shows `<!-- corpus:total-check ... -->` to
    // describe the trigger — is NOT a live marker: a real marker is a bare HTML
    // comment, never backticked. Drop inline-code spans before matching so a
    // documented example never binds to the next unrelated table. (Fenced
    // examples are handled by the `fenced` pre-scan above; this is the
    // single-line analogue. The prose-total scan below deliberately does NOT do
    // this — its backtick-strip is load-bearing for partially-coded real totals.)
    const scanLine = lines[i].replace(/`[^`]*`/g, " ");
    const markerMatch = MARKER_RE.exec(scanLine);
    if (!markerMatch) continue;

    const attrs = markerMatch[1] ?? "";
    const column = /\bcolumn\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? "";
    const proseTotals = [...attrs.matchAll(/\bprose-total\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
    const at = (kind: TableTotalViolationKind, extra: Partial<TableTotalViolation> = {}) =>
      violations.push({ file: filePath, line: i + 1, column, kind, ...extra });

    if (column === "") {
      at("missing-column-attr");
      continue;
    }

    // Bind the marker to the next non-blank line, which must start the table.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (
      j >= lines.length ||
      !isTableRow(lines[j]) ||
      !(j + 1 < lines.length && isDelimiterRow(lines[j + 1]))
    ) {
      at("no-table-after-marker");
      continue;
    }

    const header = splitRow(lines[j]);
    const columnIndex = header.indexOf(column);
    if (columnIndex === -1) {
      at("unknown-column", { detail: `headers: ${header.join(" | ")}` });
      continue;
    }

    // Collect body rows (everything after header + delimiter until the table ends).
    const bodyRows: { cells: string[]; line: number }[] = [];
    for (let k = j + 2; k < lines.length && isTableRow(lines[k]); k++) {
      bodyRows.push({ cells: splitRow(lines[k]), line: k + 1 });
    }

    const totalIndex = bodyRows.findIndex(
      (r) => stripCell(r.cells[0] ?? "").toLowerCase() === "total",
    );
    if (totalIndex === -1) {
      at("no-total-row");
      continue;
    }

    let sum = 0;
    let nonNumeric = false;
    for (let r = 0; r < bodyRows.length; r++) {
      if (r === totalIndex) continue;
      const value = parseCellNumber(bodyRows[r].cells[columnIndex]);
      if (value === null) {
        at("non-numeric-cell", {
          detail: `row ${bodyRows[r].line}, "${column}" cell: ${bodyRows[r].cells[columnIndex] ?? "(absent)"}`,
        });
        nonNumeric = true;
        break;
      }
      sum += value;
    }
    if (nonNumeric) continue;

    const asserted = parseCellNumber(bodyRows[totalIndex].cells[columnIndex]);
    if (asserted === null) {
      at("non-numeric-cell", {
        detail: `Total row, "${column}" cell: ${bodyRows[totalIndex].cells[columnIndex] ?? "(absent)"}`,
      });
      continue;
    }
    if (asserted !== sum) {
      at("total-row-mismatch", { sum, asserted });
    }

    // Every declared prose total must also equal the column sum. A prose total
    // is written one of two ways, so both shapes are recognized (bold/code
    // wrappers are stripped first, mirroring cell normalization, so `**N**` and
    // a backticked label never defeat the match):
    //   - colon form  `<label>: N`  — the number FOLLOWS the label
    //     (Spec-006 "Total enumerated event types: **130**"); tried first so the
    //     pre-existing inline-declared-total convention resolves unchanged.
    //   - prefix form `N-<label>` / `N <label>` — the number PRECEDES the label
    //     (Plan-006 "**130-event type registry across 19 categories**"). The
    //     number is left-anchored immediately before the label (only spaces /
    //     hyphens between) so a trailing "... across 19 categories" cannot supply
    //     the 19 in place of the 130.
    for (const label of proseTotals) {
      const escaped = escapeRegExp(label);
      const colonForm = new RegExp(`${escaped}\\s*:\\s*([\\d,]+)`);
      const prefixForm = new RegExp(`([\\d,]+)[\\s-]*${escaped}`);
      let found: number | null = null;
      for (let l = 0; l < lines.length; l++) {
        if (fenced[l]) continue;
        const normalized = lines[l].replace(/\*\*/g, "").replace(/`/g, "");
        const m = colonForm.exec(normalized) ?? prefixForm.exec(normalized);
        if (m) {
          found = Number.parseInt(m[1].replace(/,/g, ""), 10);
          break;
        }
      }
      if (found === null) {
        at("prose-total-not-found", { detail: `prose-total "${label}"` });
        continue;
      }
      if (found !== sum) {
        at("prose-total-mismatch", { sum, asserted: found, detail: `prose-total "${label}"` });
      }
    }
  }

  return violations;
}

export function checkTableTotalCoherence(
  files: string[],
  readContent: FileContentReader = readFromDisk,
): TableTotalViolation[] {
  const violations: TableTotalViolation[] = [];
  for (const file of files) {
    violations.push(...parseFile(file, readContent));
  }
  return violations;
}

function renderViolation(violation: TableTotalViolation): string {
  const { column, sum, asserted, detail } = violation;
  switch (violation.kind) {
    case "total-row-mismatch":
      return `"${column}" column sums to ${sum}, but the in-table **Total** row asserts ${asserted}`;
    case "prose-total-mismatch":
      return `"${column}" column sums to ${sum}, but ${detail} asserts ${asserted}`;
    case "missing-column-attr":
      return `corpus:total-check marker is missing the required column="..." attribute`;
    case "unknown-column":
      return `marked column="${column}" matches no table header (${detail})`;
    case "no-total-row":
      return `marked table has no **Total** row (first cell "Total") to reconcile`;
    case "no-table-after-marker":
      return `corpus:total-check marker is not immediately followed by a GFM table`;
    case "prose-total-not-found":
      return `declared ${detail} resolves to no "<label>: N" assertion in this document`;
    case "non-numeric-cell":
      return `non-numeric value in the summed "${column}" column — ${detail}`;
  }
}

export function formatTableTotalViolations(violations: TableTotalViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const violation of violations) {
    lines.push(
      `table-total-coherence: ${violation.file}:${violation.line} — ${renderViolation(violation)}`,
    );
  }
  lines.push("");
  lines.push(
    `table-total-coherence: ${violations.length} violation(s). Re-sum the marked column and reconcile every total assertion (the in-table **Total** row AND each declared prose total) in the same change.`,
  );
  return lines.join("\n");
}
