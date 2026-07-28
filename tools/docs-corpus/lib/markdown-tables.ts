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
 * Split one GFM table row into trimmed cells, honoring `\|` escapes.
 *
 * Walks per-character rather than splitting on `|` because the escape has to
 * be consumed as content: a `\|` contributes a literal pipe to the CELL and
 * never a boundary. Leading and trailing pipes are optional in GFM and are
 * stripped first, so `| a | b |` and `a | b` both yield two cells.
 */
export function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

export function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/**
 * A GFM delimiter row: only pipes, dashes, colons and spaces, with at least
 * one dash.
 *
 * Needs no `\|` handling, and the omission is deliberate rather than an
 * oversight: a real delimiter row cannot contain a backslash, and `\` is
 * absent from the character class, so an escaped pipe anywhere on a line
 * disqualifies it here. That fails in the safe direction — a content row
 * carrying `\|` is never mistaken for a delimiter.
 */
export function isDelimiterRow(line: string): boolean {
  const t = line.trim();
  return /-/.test(t) && /^[|\s:-]+$/.test(t);
}
