import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseFile, formatTableTotalViolations } from "../lib/table-total-coherence.ts";

function withFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "ttc-"));
  const file = resolve(dir, "case.md");
  writeFileSync(file, content);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe("table-total-coherence", () => {
  // Mirrors the real spec-006 census shape: a prose total carrying an INLINE
  // `corpus:total-check` marker (the zero-shift, prettier-stable shipping
  // placement — appended to the prose line so it adds no line and prettier leaves
  // it untouched), then the table with a bold **Total** row. 7 + 9 + 14 = 30.
  const CENSUS_OK = `# Spec

### Event Type Summary

Total enumerated event types: **30** <!-- corpus:total-check column="Count" prose-total="Total enumerated event types" -->

| Category | Count | Types |
| --- | --- | --- |
| \`a\` (one) | 7 | ... |
| \`b\` (two) | 9 | ... |
| \`c\` (three) | 14 | ... |
| **Total** | **30** | Exceeds baseline |
`;

  function mutate(replacements: [string, string][]): string {
    let out = CENSUS_OK;
    for (const [from, to] of replacements) out = out.replace(from, to);
    return out;
  }

  it("ACCEPTS a census whose column sum == Total row == prose total", () => {
    withFile(CENSUS_OK, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  // The lib supports the marker on its own line directly above the header (no
  // blank line) too — the original GFM-render-verified zero-shift form. Lock it.
  it("ACCEPTS a marker on its own line directly above the table", () => {
    const STANDALONE = `# Spec

Total enumerated event types: **30**
<!-- corpus:total-check column="Count" prose-total="Total enumerated event types" -->
| Category | Count | Types |
| --- | --- | --- |
| a | 12 | ... |
| b | 18 | ... |
| **Total** | **30** | ... |
`;
    withFile(STANDALONE, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("REJECTS in-table Total-row drift (column sums 30, Total row says 25)", () => {
    withFile(mutate([["| **Total** | **30** |", "| **Total** | **25** |"]]), (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe("total-row-mismatch");
      expect(violations[0]).toMatchObject({ sum: 30, asserted: 25 });
      expect(formatTableTotalViolations(violations)).toMatch(
        /sums to 30, but the in-table \*\*Total\*\* row asserts 25/,
      );
    });
  });

  // The PR #152 round-19 defect class: the in-table Total row tracked the column
  // (30), but the PROSE summary said 25. A check comparing only the Total row to
  // the column would PASS and miss this — the regression test that pins the
  // both-assertions design.
  it("REJECTS prose-total drift even when the in-table Total row is correct (round-19 class)", () => {
    withFile(
      mutate([["Total enumerated event types: **30**", "Total enumerated event types: **25**"]]),
      (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(1);
        expect(violations[0].kind).toBe("prose-total-mismatch");
        expect(violations[0]).toMatchObject({ sum: 30, asserted: 25 });
        expect(formatTableTotalViolations(violations)).toMatch(
          /prose-total "Total enumerated event types" asserts 25/,
        );
      },
    );
  });

  // Plan-006's census restates the total in PREFIX form — the number precedes
  // the label ("**30-event type registry across 3 categories**") — unlike
  // Spec-006's colon form. The marker binds it via prose-total; the matcher must
  // read the number to the LEFT of the label (30), never the trailing "3
  // categories". If a marker omits this binding, a prose line could drift back to
  // an old value while the column still sums right — the exact gap this guards.
  const PREFIX_OK = `# Plan

## Event Taxonomy Coverage

Plan-006 owns the **30-event type registry across 3 categories**. The 3 categories: <!-- corpus:total-check column="Count" prose-total="event type registry" -->

| Category | Count | Emitter |
| --- | --- | --- |
| a | 7 | ... |
| b | 9 | ... |
| c | 14 | ... |
| **Total** | **30** |  |
`;

  // Doubles as the left-anchor guard: the prose phrase carries a trailing "3
  // categories". A matcher that grabbed the 3 instead of the leading 30 would
  // make this fail (3 != 30); a clean parse proves the number is read to the
  // LEFT of the label.
  it("ACCEPTS a prefix-form prose total (number precedes the label)", () => {
    withFile(PREFIX_OK, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("REJECTS prefix-form prose-total drift (prose says 25, column + Total say 30)", () => {
    withFile(PREFIX_OK.replace("**30-event type registry", "**25-event type registry"), (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe("prose-total-mismatch");
      expect(violations[0]).toMatchObject({ sum: 30, asserted: 25 });
    });
  });

  it("fails LOUD when the marked column matches no header", () => {
    withFile(mutate([['column="Count"', 'column="Kount"']]), (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe("unknown-column");
    });
  });

  it("fails LOUD when a declared prose-total label resolves to nothing", () => {
    withFile(
      mutate([['prose-total="Total enumerated event types"', 'prose-total="No such label"']]),
      (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(1);
        expect(violations[0].kind).toBe("prose-total-not-found");
      },
    );
  });

  it("fails LOUD on a non-numeric value in the summed column", () => {
    withFile(mutate([["| `b` (two) | 9 |", "| `b` (two) | nine |"]]), (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe("non-numeric-cell");
    });
  });

  // The deployment-topology.md "Total participants | 5,000" false-positive trap:
  // an unmarked capacity table whose rows are independent figures. No marker →
  // never linted, even though the column does not sum to the "Total" row.
  it("IGNORES an unmarked capacity table (the false-positive trap)", () => {
    const CAPACITY = `# Deployment

## Capacity Targets

| Metric | V1 Target |
| --- | --- |
| Concurrent sessions | 1,000 |
| Participants per session | 10 |
| Total participants | 5,000 |
| Events per second | 500 |
`;
    withFile(CAPACITY, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  // The failure-mode catalog's CAT-09 row prints the marker as inline code to
  // describe the trigger (`<!-- corpus:total-check ... -->`). That is
  // documentation, not a live marker — a real marker is a bare HTML comment,
  // never backticked. Without the inline-code skip it would bind to the next
  // unrelated table (or, as here, fire `no-table-after-marker`).
  it("IGNORES a marker shown as inline code in prose (documentation, not a live marker)", () => {
    const DOC_WITH_INLINE_EXAMPLE = `# Catalog

A census table marked \`<!-- corpus:total-check column="Count" -->\` is re-summed
on every commit, so a drifted total fails CI.

| Field | Value |
| --- | --- |
| Detail | unrelated two-column table, no Total row |
`;
    withFile(DOC_WITH_INLINE_EXAMPLE, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("IGNORES a marker shown as an example inside a fenced code block", () => {
    const DOC_WITH_FENCED_EXAMPLE = `# Runbook

Declare a summable total like this:

\`\`\`markdown
<!-- corpus:total-check column="Count" -->
| Category | Count |
| --- | --- |
| a | 99 |
| **Total** | **1** |
\`\`\`

End of example.
`;
    withFile(DOC_WITH_FENCED_EXAMPLE, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("fails LOUD when the marker omits the required column attribute", () => {
    withFile(
      mutate([
        [
          '<!-- corpus:total-check column="Count" prose-total="Total enumerated event types" -->',
          '<!-- corpus:total-check prose-total="Total enumerated event types" -->',
        ],
      ]),
      (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(1);
        expect(violations[0].kind).toBe("missing-column-attr");
      },
    );
  });

  it("fails LOUD when no table follows the marker", () => {
    const ORPHAN = `# Doc

<!-- corpus:total-check column="Count" -->

Just prose, no table.
`;
    withFile(ORPHAN, (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].kind).toBe("no-table-after-marker");
    });
  });
});
