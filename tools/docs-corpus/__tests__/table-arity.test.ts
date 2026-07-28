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
    // the following commented block live.
    it("enters comment state when a line closes one comment and opens another", () => {
      withFile("<!-- note --> <!--\n| a | b |\n| --- | --- | --- |\n-->\n", (file) => {
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
    // 3-cell delimiter row.
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
        expect(parseFile(file)).toMatchObject([{ line: 9, headerLine: 7, kind: "row-arity" }]);
      });
    });

    // An unterminated opener is not front matter at all — a closing fence is
    // required for the block to exist — so the file is scanned as ordinary
    // content instead of being swallowed to end of file.
    it("treats an unterminated opener as ordinary content", () => {
      withFile(FRONT_MATTER, (file) => {
        expect(parseFile(file)).toMatchObject([
          { kind: "delimiter-arity", expected: 2, actual: 3 },
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
    // one the check declines to compare. Closing it would need full block-start
    // classification — a heading, list item, or fence abutting a table is NOT
    // absorbed — which is out of proportion to a population measured at zero
    // across the 230 enforced files.
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

    // Bound 6, the one bound in the PRECISION direction: comment state is
    // entered only from a block-level opener, so a comment opened mid-line no
    // longer suppresses its interior — that interior is read as live markup and
    // a malformed table inside it WOULD be flagged. The narrowing is worth the
    // residual: the alternative blanked out checks from any `<!--` in a code
    // span, and this shape measures zero.
    it("reads the interior of a mid-line-opened comment as live markup", () => {
      withFile("prose <!--\n| a | b |\n| --- | --- | --- |\n-->\n", (file) => {
        expect(parseFile(file)).toMatchObject([
          { kind: "delimiter-arity", expected: 2, actual: 3 },
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
  });
});
