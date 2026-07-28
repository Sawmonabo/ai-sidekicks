import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseFile, checkTableArity, formatTableArityViolations } from "../lib/table-arity.ts";
import { containsUnescapedPipe, splitRow } from "../lib/markdown-tables.ts";

function withFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "arity-"));
  const file = resolve(dir, "case.md");
  writeFileSync(file, content);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

// NOTE ON ESCAPING: in a JS template literal `\|` collapses to a bare `|` —
// the backslash is dropped for unrecognized escapes. Every fixture that must
// contain the LITERAL two characters `\|` on disk therefore writes `\\|`.
// Getting this backwards would silently turn an escaped-pipe fixture into an
// unescaped one and invert what the test proves.

describe("table-arity", () => {
  describe("negative controls — the check can actually fail", () => {
    // CONTROL 1: a zero-findings result is worthless unless the checker is
    // shown failing on known-bad input in the same run. This is the real
    // docs/specs/015 defect verbatim: `<env | file>` inside a code span
    // widened a 3-column row to 4, and the delimiter row was then "repaired"
    // to 4 dashes to match it.
    const SPEC_015_CORRUPTED = `# Spec

| Platform | Command | Pass Condition |
| --- | --- | --- | --- |
| Linux (systemd) | \`timedatectl show\` | stdout is \`yes\` |
| Container | Probe the host, not the container | via \`--ntp-sync-status-override=<env | file>\` or host D-Bus socket mount |
`;

    it("FLAGS the real Spec-015 corruption — both the widened delimiter and the split row", () => {
      withFile(SPEC_015_CORRUPTED, (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(2);
        expect(violations[0]).toMatchObject({
          line: 4,
          headerLine: 3,
          kind: "delimiter-arity",
          expected: 3,
          actual: 4,
        });
        expect(violations[1]).toMatchObject({
          line: 6,
          headerLine: 3,
          kind: "row-arity",
          expected: 3,
          actual: 4,
        });
      });
    });

    // CONTROL 2: the ESCAPED form — what the check tells authors to write — must
    // be silent, or the guidance in the failure message would be a trap. This is
    // the repaired Spec-015 table plus the PR #267 catalog fix shape
    // (`\|\| true`, two escaped pipes adjacent), which is the denser case: a
    // naive "strip \| then split" and a per-character walk can disagree on
    // adjacent escapes.
    const ESCAPED_OK = `# Spec

| Platform | Command | Pass Condition |
| --- | --- | --- |
| Linux (systemd) | \`timedatectl show\` | stdout is \`yes\` |
| Container | Probe the host, not the container | via \`--ntp-sync-status-override=<env \\| file>\` or host D-Bus socket mount |

| Hook | Guard |
| --- | --- |
| Collapsed gate input | a lane whose enumeration ends in \`\\|\\| true\` |
`;

    it("ACCEPTS escaped pipes, including two adjacent ones", () => {
      withFile(ESCAPED_OK, (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // CONTROL 3: a table inside a fence is an EXAMPLE — including a
    // deliberately-malformed one documenting this very failure mode. Suppressing
    // it is what lets the failure-mode catalog show the broken shape without the
    // gate that catches it failing on the documentation of itself.
    const FENCED_EXAMPLE = `# Spec

Here is what the corruption looks like:

\`\`\`markdown
| Platform | Command | Pass Condition |
| --- | --- | --- | --- |
| Container | Probe the host | via \`<env | file>\` |
\`\`\`

| Real | Table |
| --- | --- |
| a | b |
`;

    it("IGNORES a malformed table inside a fence, while still checking the real one after it", () => {
      withFile(FENCED_EXAMPLE, (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // The control above passes trivially if fence tracking swallowed the REST of
    // the file. Prove the fence actually closed: same fixture with the trailing
    // table corrupted must now flag, which can only happen if scanning resumed.
    it("resumes scanning after the fence closes (the suppression is bounded)", () => {
      const withBadTrailer = FENCED_EXAMPLE.replace("| a | b |", "| a | b | c |");
      withFile(withBadTrailer, (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ kind: "row-arity", expected: 2, actual: 3 });
      });
    });
  });

  describe("arity comparison", () => {
    it("FLAGS a row wider than its header", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
      });
    });

    it("FLAGS a row narrower than its header", () => {
      withFile("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 3, actual: 2 }]);
      });
    });

    it("reports every offending row, not just the first", () => {
      withFile(
        "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n| 4 |\n| 5 | 6 |\n| 7 | 8 | 9 |\n",
        (file) => {
          expect(parseFile(file).map((violation) => violation.line)).toEqual([3, 4, 6]);
        },
      );
    });

    it("measures each table against its OWN header", () => {
      withFile(
        "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| x | y | z |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
        (file) => {
          expect(parseFile(file)).toEqual([]);
        },
      );
    });
  });

  describe("table detection", () => {
    it("does not treat a horizontal rule as a table", () => {
      withFile("some prose\n\n---\n\nmore prose\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // The cell counts here deliberately DISAGREE (2 then 1). Equal counts would
    // pass whether or not the delimiter row is required, so the test would prove
    // nothing — the first version of it did exactly that and a mutation dropping
    // the `isDelimiterRow` requirement survived the whole suite.
    it("requires a delimiter row — consecutive pipe-bearing prose lines are not a table", () => {
      withFile("| alpha | beta |\n| gamma |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("checks a table at end-of-file with no trailing newline", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", actual: 3 }]);
      });
    });

    it("checks a table inside a blockquote", () => {
      withFile("> | a | b |\n> | --- | --- |\n> | 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
      });
    });

    // GFM makes the outer pipes optional, so this IS a body row — and its
    // excess cell is exactly the corruption the check exists to find. The
    // earlier version of this test used a matching-arity row (`a | b` under a
    // 2-cell header), which passed whether the body loop continued over it or
    // ended at it, so the false negative went unpinned (Codex, PR #269 R1).
    it("FLAGS an over-wide body row written without outer pipes", () => {
      withFile("| a | b |\n| --- | --- |\n1 | 2 | 3\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
      });
    });

    it("accepts a matching-arity body row written without outer pipes", () => {
      withFile("| a | b |\n| --- | --- |\na | b\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("ends the table at a blank line, not at the first pipe-less row", () => {
      withFile("| a | b |\n| --- | --- |\n1 | 2 | 3\n\n1 | 2 | 3\n", (file) => {
        // Only the row INSIDE the table is compared; the one after the blank
        // line belongs to no table.
        expect(parseFile(file)).toMatchObject([{ line: 3, kind: "row-arity" }]);
      });
    });

    it("accepts alignment markers in the delimiter row", () => {
      withFile("| a | b | c |\n|:--- | :---: | ---:|\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });
  });

  // A table opens only at a BLOCK BOUNDARY, and a body line that starts a new
  // block closes the table instead of being compared as a row. Three review
  // rounds returned findings of one shape — a table-shaped line that is not a
  // table — so this is the general rule rather than a fourth context-specific
  // suppression (Codex, PR #269 round 3).
  describe("block boundaries", () => {
    it("recognizes a table that is the file's first content line", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 3, kind: "row-arity", actual: 3 }]);
      });
    });

    // The boundary-leaving lines, each with NO blank line before the table: a
    // heading is a one-line block, and a fence or comment closer ends its own.
    // Miss any of these and the rule stops being a boundary rule and starts
    // being "must follow a blank line", which would blind the check to real
    // tables — the recall direction this design spends its budget avoiding.
    it("recognizes a table abutting a heading", () => {
      withFile("# Doc\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 4, kind: "row-arity", actual: 3 }]);
      });
    });

    it("recognizes a table abutting a closing fence", () => {
      withFile("```\ncode\n```\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 6, kind: "row-arity", actual: 3 }]);
      });
    });

    it("recognizes a table abutting a comment closer", () => {
      withFile("<!--\nnote\n-->\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 6, kind: "row-arity", actual: 3 }]);
      });
    });

    // A paragraph line then a header/delimiter pair. Whether a table may
    // INTERRUPT a paragraph is contested — the GFM spec is silent on it and
    // implementations diverge — so the check declines to classify the shape
    // rather than adjudicating the question (bound 7).
    it("does not recognize a header/delimiter pair continuing a paragraph", () => {
      withFile("text\n| a | b |\n| --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // The discriminating half: the SAME pair one blank line down is a table and
    // still flags. Without it, a mutation that never recognizes anything would
    // pass the case above.
    it("recognizes the same pair once a blank line precedes it", () => {
      withFile("text\n\n| a | b |\n| --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { line: 4, headerLine: 3, kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });

    // Unlike the pair above, this exclusion is NOT contested: CommonMark lets a
    // blockquote interrupt a paragraph, so GFM renders this quoted table. It is
    // bound 7's one plain recall miss — declined because the prose line leaves
    // no boundary, measured zero, and disclosed as such in the module header.
    it("does not recognize a quoted pair directly under unquoted prose", () => {
      withFile("text\n> | a | b |\n> | --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // A table drawn inside `<div>` is raw HTML, which GFM does not parse as
    // markdown at all. The tag line being a non-boundary excludes it with no
    // HTML state machine — the alternative the reviewer raising it also
    // declined.
    it("does not recognize a table wrapped in a `<div>`", () => {
      withFile("<div>\n| a | b |\n| --- | --- | --- |\n</div>\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // A blank line ENDS a CommonMark type-6 HTML block, so what follows is
    // markdown again and the table is real. The pair is what makes this a
    // boundary rule rather than a `<div>`-shaped suppression.
    it("recognizes a table after a blank line inside a `<div>` block", () => {
      withFile("<div>\n\n| a | b |\n| --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { line: 4, headerLine: 3, kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });

    // GFM ends a table "at the first empty line, or beginning of another
    // block-level structure", so a pipe-bearing heading, list item or HTML tag
    // is the NEXT block, never a malformed row of the table above it — which is
    // what the check reported before (Codex, PR #269 round 3). Each fixture
    // keeps a genuinely broken row above the block start, so passing by
    // suppressing the whole table is not available.
    it("ends the table at a pipe-bearing heading, still checking the rows above", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n# A | B | C\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 3, kind: "row-arity", actual: 3 }]);
      });
    });

    it("ends the table at a pipe-bearing list item, still checking the rows above", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n- item | x | y\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 3, kind: "row-arity", actual: 3 }]);
      });
    });

    it("ends the table at a pipe-bearing HTML tag, still checking the rows above", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n<div> | x | y\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 3, kind: "row-arity", actual: 3 }]);
      });
    });

    // A table's own header and delimiter are block machinery, so the pair
    // leaves a boundary behind it. Without that, the first line after a table
    // could never open one — here a depth change ends the unquoted table and
    // the quoted table immediately below it, with no blank line between, is
    // still recognized and still flagged.
    it("leaves a boundary after a recognized pair, so an abutting table opens", () => {
      withFile("| a | b |\n| --- | --- |\n> | x | y |\n> | --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { line: 4, headerLine: 3, kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });

    // The block start falls through to the recognition branch on its way out,
    // where a mis-ordered classifier would let it open a table of its own. The
    // delimiter-shaped line beneath it is what makes that visible.
    it("does not open a new table from the block-start line that closed one", () => {
      withFile(
        "| a | b |\n| --- | --- |\n| 1 | 2 |\n- item | x | y\n| --- | --- | --- |\n",
        (file) => {
          expect(parseFile(file)).toEqual([]);
        },
      );
    });
  });

  // GFM's delimiter row holds "cells whose only content are hyphens and
  // optionally, a leading or trailing colon, or both". `isDelimiterRow` asks
  // only for one dash somewhere in a line of pipes, spaces, colons and dashes,
  // so `| --- | : |` satisfied it while GFM rejects the table outright (Codex,
  // PR #269 round 3). The per-cell rule is local to `table-arity.ts`:
  // `isDelimiterRow` is shared with table-total-coherence, where narrowing it
  // would change a required gate's table-boundary detection.
  describe("delimiter cell grammar", () => {
    it("DECLINES a pair whose delimiter carries a colon-only cell", () => {
      withFile("| a | b |\n| --- | : |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // Declining means the block is not a table at all, so the rows beneath are
    // not compared either. A decline that still opened a table would report row
    // arity against a header GFM never rendered.
    it("leaves no table open after declining, so later rows are not compared", () => {
      withFile("| a | b |\n| --- | : |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // The rule must not over-reject: colons on either side or both are legal
    // alignment. Recognition is what this assertion rests on, since the body
    // row is the thing being flagged.
    it("still recognizes a delimiter built from legal alignment cells", () => {
      withFile("| a | b |\n| :-: | ---: |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
      });
    });

    // The Spec-015 class itself: every cell well formed, the COUNT wrong. Cell
    // validation runs before the arity comparison, so this must still reach it
    // — the ordering is what keeps the check's primary finding.
    it("still flags a well-formed delimiter with the wrong cell count", () => {
      withFile("| a | b |\n| --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });
  });

  // CommonMark caps a block at three spaces of indentation; four or more (or a
  // tab) makes it an indented CODE block. Without the bound, a table-shaped
  // EXAMPLE indented under a list or paragraph reads as live markup and can
  // fail the gate on documentation (Codex, PR #269 R1).
  describe("indentation bound", () => {
    it("IGNORES a malformed table indented four spaces (indented code)", () => {
      withFile("    | a | b |\n    | --- | --- | --- |\n    | 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("IGNORES a tab-indented malformed table", () => {
      withFile("\t| a | b |\n\t| --- | --- | --- |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // The bound must not over-suppress: three spaces is still a live table.
    it("FLAGS a broken table indented three spaces", () => {
      withFile("   | a | b |\n   | --- | --- |\n   | 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
      });
    });
  });

  // HTML comment content is not rendered as markdown, so a malformed table
  // drawn inside one is documentation, not a table (Codex, PR #269 R1).
  describe("HTML comment state", () => {
    const COMMENTED = `<!--
| a | b |
| --- | --- | --- |
| 1 | 2 | 3 |
-->

| Real | Table |
| --- | --- |
| x | y |
`;

    it("IGNORES a malformed table inside a multi-line comment", () => {
      withFile(COMMENTED, (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // Bounded-suppression control, mirroring the fence one: if the comment
    // never closed, the trailing table would be swallowed and this would pass
    // for the wrong reason. The mutated row is deliberately spelled `| x | y |`
    // — unique to the REAL table, because the commented block above also holds
    // an `| a | b |` row and replacing that one corrupts the suppressed copy
    // while leaving the live table intact (caught by this control on first run).
    it("resumes scanning after the comment closes", () => {
      withFile(COMMENTED.replace("| x | y |\n", "| x | y | z |\n"), (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ kind: "row-arity", expected: 2, actual: 3 });
      });
    });

    it("does NOT suppress a row carrying an inline comment that also closes", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 | <!-- note -->\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 4 }]);
      });
    });

    // A line can CLOSE one comment and OPEN another. The open scan reads the
    // LAST `<!--` on the line for exactly this case: scanning from the first
    // one finds the intervening `-->`, concludes the comment closed, and leaves
    // the following commented block live. The blank line inside the comment is
    // what makes the fixture discriminate: without it the boundary rule (bound
    // 7) declines the table shape anyway, since the opener line is prose, and
    // a first-`<!--` scan becomes invisible to the suite.
    it("enters comment state when a line closes one comment and opens another", () => {
      withFile("<!-- note --> <!--\n\n| a | b |\n| --- | --- | --- |\n-->\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // Comment state is entered only from a BLOCK-LEVEL opener. Scanning for
    // `<!--` anywhere on the line meant a code span holding those literal
    // characters — prose about HTML comments, which this corpus writes — blanked
    // out every check to the next `-->` or to end of file (Codex, PR #269 R2).
    it("does NOT enter comment state from `<!--` inside a code span", () => {
      withFile(
        "Suppression begins at a `<!--` opener.\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n",
        (file) => {
          expect(parseFile(file)).toMatchObject([{ line: 5, kind: "row-arity", actual: 3 }]);
        },
      );
    });

    // An HTML block interrupts what precedes it and its content is not
    // markdown, so the OPENER line is suppressed exactly like the closer. The
    // opener falling through to the body comparison flagged the pipes in a line
    // GFM renders as an HTML block, never as a row.
    it("does not compare the pipes on a block-level comment opener line", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 |\n<!-- | x | y | z |\n-->\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });
  });

  // GFM builds a table only from rows in the same container. Without a depth
  // check the parser synthesizes a table GFM never renders — a false POSITIVE
  // class, which is why this one is a guard rather than a disclosed bound
  // (Codex, PR #269 R2). Depth is counted, not stacked: a container stack is
  // the unbounded path this check declines.
  describe("blockquote depth", () => {
    // The delimiter arity deliberately DISAGREES with the header's. A matching
    // delimiter makes the fixture pass on the body guard alone, so dropping the
    // open-side equality survived it — the first version of this test did
    // exactly that.
    it("does not synthesize a table from a quoted header and an unquoted delimiter", () => {
      withFile("> | a | b |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("ends the table when a body row changes depth", () => {
      withFile("| a | b |\n| --- | --- |\n> | 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // The guard must not collapse to "unquoted only" — a consistently quoted
    // table at any depth is a real table and stays checked.
    it("checks a consistently double-quoted table", () => {
      withFile(">> | a | b |\n>> | --- | --- |\n>> | 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
      });
    });
  });

  // Front matter is YAML, not markdown — GitHub renders it as document
  // metadata. 27 enforced files carry it (agent definitions, skill files,
  // preflight fixtures); none holds a pipe today, so this protects a real
  // population against a future `description: a | b` rather than repairing a
  // live break (Codex, PR #269 R2).
  describe("YAML front matter", () => {
    // A folded block scalar carrying markdown is the plausible shape, and it
    // discriminates: without the suppression these two lines are a header and a
    // 3-cell delimiter row. The blank line inside the scalar is load-bearing —
    // it puts that shape at a block boundary, so the front-matter skip is the
    // ONLY thing that can suppress it. Without the blank line the boundary rule
    // (bound 7) declines the shape as paragraph continuation as well, and
    // deleting the front-matter tracker outright becomes invisible to the suite
    // — which is exactly what the round-3 mutation matrix caught.
    const FRONT_MATTER = `---
description: >

  | a | b |
  | --- | --- | --- |
`;

    it("ignores markdown-shaped content inside leading front matter", () => {
      withFile(`${FRONT_MATTER}---\n\n# Doc\n`, (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("accepts `...` as the terminator", () => {
      withFile(`${FRONT_MATTER}...\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n`, (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("checks content after the terminator normally, at its true line numbers", () => {
      withFile(`${FRONT_MATTER}---\n\n| x | y |\n| --- | --- |\n| 1 | 2 | 3 |\n`, (file) => {
        expect(parseFile(file)).toMatchObject([{ line: 10, headerLine: 8, kind: "row-arity" }]);
      });
    });

    // An unterminated opener is not front matter at all — a closing fence is
    // required for the block to exist — so the file is scanned as ordinary
    // content instead of being swallowed to end of file.
    it("treats an unterminated opener as ordinary content", () => {
      withFile(FRONT_MATTER, (file) => {
        expect(parseFile(file)).toMatchObject([
          { line: 5, headerLine: 4, kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });

    // TWO thematic breaks, with the broken table between them: a tracker that
    // scanned forward for its opener instead of requiring line 1 would pair
    // them and skip everything in between. With a single break there is no
    // terminator to find, such a tracker gives up, and the fixture passes
    // either way — which is how the first version of this test let that
    // mutation live.
    it("does not treat a mid-file `---` as front matter", () => {
      withFile("# Doc\n\n---\n\n| a | b |\n| --- | --- | --- |\n\n---\n\nafter\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });
  });

  // The runner validates the COMMIT, not the editor buffer: it hands the check
  // the same commit-snapshot (`git show :path`) reader its cite checks use, so
  // a staged-broken table fixed only in the worktree still blocks (Codex,
  // PR #269 R2). The default reads from disk, which is what these tests and
  // ad-hoc probes want.
  describe("injected content reader", () => {
    it("checks the INJECTED content, not what is on disk", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 |\n", (file) => {
        const staged = "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n";
        expect(parseFile(file, () => staged)).toMatchObject([
          { kind: "row-arity", expected: 2, actual: 3 },
        ]);
        // Same path, default reader: the clean worktree copy. The pair is what
        // proves the injection is live rather than incidentally agreeing.
        expect(parseFile(file)).toEqual([]);
      });
    });

    it("forwards the reader through checkTableArity", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 |\n", (file) => {
        expect(checkTableArity([file], () => "| a |\n| --- |\n| 1 | 2 |\n")).toMatchObject([
          { kind: "row-arity", expected: 1, actual: 2 },
        ]);
        expect(checkTableArity([file])).toEqual([]);
      });
    });
  });

  // Escape handling is by backslash-RUN PARITY. The naive "is the previous
  // character a backslash" test read `\\|` (escaped backslash + live
  // delimiter) as an escaped pipe and undercounted the row (Codex, PR #269 R1).
  // Fixtures use String.raw so the backslash counts in the SOURCE are exactly
  // what reaches the splitter — with an ordinary template literal `\|` would
  // collapse to a bare pipe and invert what each case proves.
  describe("backslash-run parity", () => {
    // Inputs use String.raw (source bytes as written); expectations use
    // ordinary escapes, so `"x \\"` below is the two characters `x \`.
    it("treats an ODD run before a pipe as an escape", () => {
      expect(splitRow(String.raw`x \| y`)).toEqual(["x | y"]);
      expect(splitRow(String.raw`x \\\| y`)).toEqual(["x \\| y"]);
    });

    it("treats an EVEN run before a pipe as a live delimiter", () => {
      expect(splitRow(String.raw`x \\| y`)).toEqual(["x \\", "y"]);
      expect(splitRow(String.raw`x \\\\| y`)).toEqual(["x \\\\", "y"]);
    });

    it("keeps a lone backslash before a NON-pipe as content", () => {
      expect(splitRow(String.raw`x \y | z`)).toEqual(["x \\y", "z"]);
    });

    it("applies the same parity to the body-continuation test", () => {
      expect(containsUnescapedPipe(String.raw`x \| y`)).toBe(false);
      expect(containsUnescapedPipe(String.raw`x \\| y`)).toBe(true);
      expect(containsUnescapedPipe(String.raw`x \\\| y`)).toBe(false);
      expect(containsUnescapedPipe("no pipes here")).toBe(false);
    });

    it("counts an even-run row at its true arity end to end", () => {
      withFile(
        `| a | b |
| --- | --- |
${String.raw`| x \\| y | z |`}
`,
        (file) => {
          // `\\|` is an escaped backslash then a REAL delimiter, so this row
          // holds three cells against a two-cell header.
          expect(parseFile(file)).toMatchObject([{ kind: "row-arity", expected: 2, actual: 3 }]);
        },
      );
    });
  });

  // The recognized subset's edge. Every bound below is measured at ZERO over
  // the 230 enforced `.md` files, with a predicate proven to fire on a
  // synthetic positive in the same run — and pinned here so it stays a decision
  // on record rather than an unnoticed gap.
  describe("disclosed bounds", () => {
    // Arity is a WITHIN-table invariant by design: it finds rows that disagree
    // with their header, never headers that disagree with the author's intent.
    // A uniformly-wrong table is internally consistent and passes — pinned so
    // the bound is a decision on record rather than an unnoticed gap.
    it("PASSES a table whose header itself is wrong, as long as it is self-consistent", () => {
      withFile("| a | b | stray | \n| --- | --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // A table whose HEADER omits the outer pipes is never recognized, so its
    // rows are never compared — this row is 3 cells against a 2-cell header and
    // still passes. Pinned deliberately: `isTableRow` is shared with
    // table-total-coherence, so widening it would change a required gate's
    // table-boundary detection. The enforced corpus was probed for this shape
    // and holds zero instances (see the module header), which is what makes the
    // bound tolerable rather than a live hole.
    it("does NOT see a table whose header omits outer pipes", () => {
      withFile("a | b\n--- | ---\n1 | 2 | 3\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // GFM absorbs a non-empty pipe-less line abutting a table as a lazy
    // one-cell continuation row (the spec's own `bar` example), so this row is
    // one the check declines to compare. The shapes GFM does NOT absorb — a
    // heading, list item, HTML tag or fence abutting a table — are classified
    // rather than left to this bound (see "block boundaries" above), so what
    // remains here is the lazy prose case alone, measured at zero across the
    // 230 enforced files.
    it("ends the table at a pipe-less line GFM would absorb", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 |\nbar\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // Bound 3: the line carrying `-->` is suppressed whole, so live markup in
    // its tail is not checked. Also measured at zero.
    it("does not check live markup in the tail after a comment closes", () => {
      withFile("<!--\ncomment\n--> | a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // Bound 4: four spaces or a tab makes the block indented code. This is the
    // superset of the list-container case — a table nested under a list item
    // carries that indentation — and taking it as one indentation rule is what
    // avoids tracking container stacks for a population measured at zero.
    it("does not see a table indented under a list item", () => {
      withFile("- item\n\n    | a | b |\n    | --- | --- | --- |\n    | 1 | 2 | 3 |\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // Bound 6, one of the two bounds in the PRECISION direction: comment state
    // is entered only from a block-level opener, so a comment opened mid-line
    // no longer suppresses its interior — that interior is read as live markup.
    // The narrowing is worth the residual: the alternative blanked out checks
    // from any `<!--` in a code span, and this shape measures zero.
    //
    // Bound 7 then cuts the residual down, which is why this pair replaces the
    // single wider assertion the previous round pinned. The opener line is
    // prose, so it leaves no block boundary and the first interior line opens
    // nothing:
    it("does not recognize a table on the first line inside a mid-line comment", () => {
      withFile("prose <!--\n| a | b |\n| --- | --- | --- |\n-->\n", (file) => {
        expect(parseFile(file)).toEqual([]);
      });
    });

    // ...and what survives needs an interior BLANK line to re-open a boundary.
    // This is the residual as it actually stands — pinned separately so it is
    // not mistaken for the wider one, and so a mutation restoring the wider
    // exposure has a fixture that disagrees with it.
    it("reads markup after a blank line inside a mid-line comment as live", () => {
      withFile("prose <!--\n\n| a | b |\n| --- | --- | --- |\n-->\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { line: 4, headerLine: 3, kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });

    // Bound 8, the other PRECISION bound: a CommonMark TYPE-1 HTML block
    // (`pre`, `script`, `style`, `textarea`) spans blank lines, while a blank
    // line opens a boundary here unconditionally — so a table shape after one
    // inside such a block is read as live markup. Excluding it means tracking
    // type-1 openers against their matching closers, HTML state this design
    // declines to hold for a population measured at zero. The type-6 case
    // (`<div>`, under "block boundaries") is NOT this: those blocks END at a
    // blank line, so reading what follows as markdown is correct there.
    it("reads a table shape after a blank line inside a `<pre>` block as live", () => {
      withFile("<pre>\nliteral\n\n| a | b |\n| --- | --- | --- |\n</pre>\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { line: 5, headerLine: 4, kind: "delimiter-arity", expected: 2, actual: 3 },
        ]);
      });
    });
  });

  describe("checkTableArity + formatting", () => {
    it("aggregates across files", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (first) => {
        withFile("| x | y |\n| --- | --- |\n| 1 |\n", (second) => {
          expect(checkTableArity([first, second])).toHaveLength(2);
          expect(checkTableArity([])).toEqual([]);
        });
      });
    });

    it("renders nothing for a clean run", () => {
      expect(formatTableArityViolations([])).toBe("");
    });

    it("names the file, both line numbers, both counts, and the escape to use", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        const rendered = formatTableArityViolations(parseFile(file));
        expect(rendered).toContain(`${file}:3`);
        expect(rendered).toContain("3 cell(s)");
        expect(rendered).toContain("header (line 1) has 2");
        expect(rendered).toContain("\\|");
        // The remediation warning is the load-bearing half: widening the
        // delimiter row is what turned the Spec-015 typo into a permanent,
        // prettier-stable corruption.
        expect(rendered).toContain("Do NOT reconcile by widening the delimiter row");
      });
    });

    // Each kind names its RENDERED consequence, per the GFM tables extension
    // (https://github.github.com/gfm/#tables-extension-). "Off by one cell"
    // reads as cosmetic until you know the block stops being a table, or that
    // the surplus cell is dropped from the output entirely.
    it("names the GFM consequence per violation kind", () => {
      withFile("| a | b |\n| --- | --- | --- |\n", (file) => {
        expect(formatTableArityViolations(parseFile(file))).toContain(
          "does not recognize this block as a table at all",
        );
      });
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        expect(formatTableArityViolations(parseFile(file))).toContain(
          "ignores the excess cell — that content is silently dropped",
        );
      });
      withFile("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n", (file) => {
        expect(formatTableArityViolations(parseFile(file))).toContain(
          "renders the missing cells as empty",
        );
      });
    });

    // The remedy is direction-specific and the two directions are OPPOSITES. An
    // unconditional "never widen the delimiter row" trailer contradicted the
    // per-violation line for a row NARROWER than its header, where widening a
    // short delimiter is the only repair (Codex, PR #269 round 3).
    it("gives the widening ban only when a row is WIDER than its header", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (file) => {
        const rendered = formatTableArityViolations(parseFile(file));
        expect(rendered).toContain("Do NOT reconcile by widening the delimiter row");
        expect(rendered).not.toContain("NARROWER than the header");
      });
    });

    it("gives the add-cells remedy, and no widening ban, when a row is NARROWER", () => {
      withFile("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n", (file) => {
        const rendered = formatTableArityViolations(parseFile(file));
        expect(rendered).toContain("NARROWER than the header");
        expect(rendered).toContain("that means widening it");
        expect(rendered).not.toContain("Do NOT reconcile by widening the delimiter row");
      });
    });

    // The runner reports every staged file in one message, so a batch spanning
    // both directions is the ordinary case rather than an edge — each remedy
    // scoped to the direction that earned it.
    it("emits both remedies for a mixed batch", () => {
      withFile("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n", (wider) => {
        withFile("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n", (narrower) => {
          const rendered = formatTableArityViolations(checkTableArity([wider, narrower]));
          expect(rendered).toContain("WIDER than the header");
          expect(rendered).toContain("NARROWER than the header");
        });
      });
    });
  });
});
