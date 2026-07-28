// Shared GFM table-row primitives — the ONE implementation behind every
// table-aware docs-corpus scanner (table-total-coherence's column sums,
// table-arity's cell-count check). Sibling of `markdown-fences.ts` and it
// exists for the same reason: `splitRow`'s escape handling is the rule both
// consumers turn on, and a second private copy would drift from it exactly as
// the fence trackers did (PR #207 rounds 2-4, PR #265).
//
// The load-bearing rule is `\|`. In a GFM table a literal `|` splits cells
// EVEN INSIDE a code span — a backtick offers no protection — so `\|` is the
// only way to write one, and a scanner that counts raw pipes reads an escaped
// pipe as a cell boundary. That is not hypothetical: it is the PR #267 catalog
// corruption and the Spec-015 defect, both authored independently.
//
// Deliberately dependency-free (pure string functions, no fs, no imports), so
// any lib module can take it without risking the import cycle that keeps the
// fence tracker in its own module.

/**
 * Split one GFM table row into trimmed cells, honoring backslash escapes.
 *
 * Escape handling is by RUN PARITY, not by "is the previous character a
 * backslash" — the two disagree exactly where it matters. A backslash run of
 * length N before a pipe contributes `N >> 1` literal backslashes to the cell,
 * and only an ODD run leaves a backslash over to escape the pipe:
 *
 *   `a \| b`    → one cell   (escaped pipe, content `a | b`)
 *   `a \\| b`   → TWO cells  (escaped BACKSLASH, then a live delimiter)
 *   `a \\\| b`  → one cell   (escaped backslash, then an escaped pipe)
 *
 * The naive previous-character test read `\\|` as an escaped pipe and
 * undercounted the row (Codex, PR #269 round 1). An odd run followed by a
 * non-pipe keeps the lone backslash as content and does NOT consume the next
 * character, so cell CONTENT — which table-total-coherence parses for numbers
 * and header names, not just counts — round-trips unchanged.
 *
 * Leading and trailing pipes are optional in GFM and are stripped first, so
 * `| a | b |` and `a | b` both yield two cells.
 */
export function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === "\\") {
      let runLength = 0;
      while (index < trimmed.length && trimmed[index] === "\\") {
        runLength++;
        index++;
      }
      current += "\\".repeat(runLength >> 1);
      if (runLength % 2 === 1) {
        if (index < trimmed.length && trimmed[index] === "|") {
          current += "|";
          index++;
        } else {
          current += "\\";
        }
      }
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      index++;
      continue;
    }
    current += character;
    index++;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Does this line carry a pipe that GFM would read as a cell delimiter?
 *
 * The continuation test for table bodies: GFM makes the outer pipes optional,
 * so `1 | 2 | 3` under a header is a real body row whose excess cell is
 * silently dropped — the exact corruption this corpus gates — and a
 * leading-pipe-only test would end the table before reaching it (Codex,
 * PR #269 round 1). Same run-parity rule as `splitRow`.
 */
export function containsUnescapedPipe(line: string): boolean {
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\\") {
      let runLength = 0;
      while (index < line.length && line[index] === "\\") {
        runLength++;
        index++;
      }
      // An odd run escapes whatever follows — including a pipe, which is then
      // content rather than a delimiter.
      if (runLength % 2 === 1 && index < line.length) index++;
      continue;
    }
    if (line[index] === "|") return true;
    index++;
  }
  return false;
}

export function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/**
 * May this line open a GFM table (as its header or delimiter row)?
 *
 * CommonMark allows a block to carry at most three spaces of indentation; four
 * or more — or a tab, which expands past the limit — makes it an indented CODE
 * block, so a table-shaped EXAMPLE indented under a list or paragraph is
 * literal text and not a table at all. Without this bound the check reads such
 * an example as live markup and can fail the gate on documentation (Codex,
 * PR #269 round 1). Body rows are deliberately not held to it: they join an
 * already-open table by lazy continuation.
 */
export function hasLegalTableIndent(line: string): boolean {
  const leadingWhitespace = /^[ \t]*/.exec(line)?.[0] ?? "";
  return !leadingWhitespace.includes("\t") && leadingWhitespace.length <= 3;
}

/**
 * A GFM delimiter row: only pipes, dashes, colons and spaces, with at least
 * one dash.
 *
 * Needs no escape handling, and the omission is deliberate rather than an
 * oversight: a real delimiter row cannot contain a backslash, and `\` is
 * absent from the character class, so an escaped pipe anywhere on a line
 * disqualifies it here. That fails in the safe direction — a content row
 * carrying `\|` is never mistaken for a delimiter.
 */
export function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  return /-/.test(t) && /^[|\s:-]+$/.test(t);
}
