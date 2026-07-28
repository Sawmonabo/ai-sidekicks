import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseFile,
  formatMermaidViolations,
  checkMermaidSetCoherence,
} from "../lib/mermaid-set-coherence.ts";

function withFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "msc-"));
  const file = resolve(dir, "case.md");
  writeFileSync(file, content);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

describe("mermaid-set-coherence", () => {
  // PR #27 round 2: NS-22 was added as a :::ready graph node but the prose
  // enumeration `(NS-01, NS-03, NS-04, NS-11, NS-12, NS-13a, NS-14)` did not
  // include it — yet was claimed to "share no code paths" with the rest.
  const PR27_PRE_FIX = `
# Page

\`\`\`mermaid
graph TB
  NS01[NS-01: foo]:::ready
  NS03[NS-03: bar]:::ready
  NS04[NS-04: baz]:::ready
  NS11[NS-11: qux]:::ready
  NS12[NS-12: quux]:::ready
  NS13a[NS-13a: corge]:::ready
  NS14[NS-14: grault]:::ready
  NS22[NS-22: garply]:::ready

  classDef ready fill:#9f9,stroke:#0a0,color:#000
\`\`\`

The ready set (NS-01, NS-03, NS-04, NS-11, NS-12, NS-13a, NS-14) shares no code paths.
`;

  // Fix variant A: NS-22 dropped from graph; prose unchanged.
  const PR27_POST_FIX_A = `
# Page

\`\`\`mermaid
graph TB
  NS01[NS-01: foo]:::ready
  NS03[NS-03: bar]:::ready

  classDef ready fill:#9f9,stroke:#0a0,color:#000
\`\`\`

The ready set (NS-01, NS-03) shares no code paths.
`;

  // Fix variant B: NS-22 reclassified :::blocked (the actual landed fix).
  const PR27_POST_FIX_B = `
# Page

\`\`\`mermaid
graph TB
  NS01[NS-01: foo]:::ready
  NS22[NS-22: garply]:::blocked

  classDef ready fill:#9f9,stroke:#0a0,color:#000
  classDef blocked fill:#fcc,stroke:#a00,color:#000
\`\`\`

The ready set (NS-01) shares no code paths.
`;

  it("REJECTS the pre-fix PR-#27 round 2 state (NS-22 in :::ready, missing from prose)", () => {
    withFile(PR27_PRE_FIX, (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].extra).toContain("NS22");
      expect(formatMermaidViolations(violations)).toMatch(/in graph but not prose: NS22/);
    });
  });

  it("ACCEPTS PR-#27 fix variant A (NS-22 dropped from graph + prose)", () => {
    withFile(PR27_POST_FIX_A, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("ACCEPTS PR-#27 fix variant B (NS-22 reclassified :::blocked)", () => {
    withFile(PR27_POST_FIX_B, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("does nothing on a doc with neither classDef nor enumeration", () => {
    withFile("# Just prose\n\nA paragraph.\n", (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });
});

// checkMermaidSetCoherence is the entry point the runner actually calls
// (pre-commit-runner.ts), yet every test above exercises parseFile instead —
// so a version that read only files[0] passed the whole suite (CAT-10 mutation
// pass 3). The risk here is AGGREGATION, not existence: a single-file fixture
// cannot tell a correct loop apart from one that drops every file after the
// first, which is why both cases below use two files and assert WHICH file
// each violation came from rather than only how many there were.
describe("mermaid-set-coherence — checkMermaidSetCoherence multi-file aggregation", () => {
  const GRAPH = [
    "```mermaid",
    "graph TB",
    "  NS01[NS-01: foo]:::ready",
    "  NS22[NS-22: garply]:::ready",
    "",
    "  classDef ready fill:#9f9,stroke:#0a0,color:#000",
    "```",
    "",
  ];
  const VIOLATING = [
    "# Page",
    "",
    ...GRAPH,
    "The ready set (NS-01) shares no code paths.",
    "",
  ].join("\n");
  const CLEAN = [
    "# Page",
    "",
    ...GRAPH,
    "The ready set (NS-01, NS-22) shares no code paths.",
    "",
  ].join("\n");

  function withFiles(contents: string[], fn: (paths: string[]) => void): void {
    const dir = mkdtempSync(resolve(tmpdir(), "msc-multi-"));
    const paths = contents.map((content, index) => {
      const file = resolve(dir, `case-${index}.md`);
      writeFileSync(file, content);
      return file;
    });
    try {
      fn(paths);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }

  it("reports a violation that lives in the LAST file, not just the first", () => {
    // Fails against a walk that stops after files[0] — the exact mutation that
    // survived the parseFile-only suite.
    withFiles([CLEAN, VIOLATING], ([first, second]) => {
      const violations = checkMermaidSetCoherence([first, second]);
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toBe(second);
      expect(violations[0].extra).toContain("NS22");
    });
  });

  it("accumulates across files and attributes each violation to its own file", () => {
    // The complement: a walk that kept only the LAST file's results would pass
    // the case above. Pinning the file field in order fails both directions.
    withFiles([VIOLATING, VIOLATING], ([first, second]) => {
      const violations = checkMermaidSetCoherence([first, second]);
      expect(violations).toHaveLength(2);
      expect(violations.map((violation) => violation.file)).toEqual([first, second]);
    });
  });
});

// KNOWN GAP — these tests pin behavior this checker does NOT have. They are
// characterization tests of a live blind spot, not statements that the blind
// spot is correct. Read the block comment before "fixing" a failure here.
//
// Measured 2026-07-28 against the checker's real denominator — the two files in
// docs/ that carry a mermaid `classDef` (cross-plan-dependencies.md and
// 2026-05-03-plan-execution-housekeeper-design.md). Running the shipped
// checkMermaidSetCoherence over both returns []. Every live set claim in
// cross-plan-dependencies.md uses the brace form `<adjective> set **{…}**`,
// whose adjectives (ready/blocked/completed/governance) ARE declared classDef
// names — so the adjective guard passes and only the `(` delimiter blocks the
// match. This gate has never fired on a corpus line in either form.
//
// Widening ENUM_RE to accept braces is NOT a safe mechanical fix, which is why
// it is not done here: all 12 live brace instances are HISTORICAL RECORDS
// (dated `- **YYYY-MM-DD amendment (PR #NNN):**` bullets, or `Status:
// completed (resolved …)` lines under `### NS-NN`). They describe the DAG at a
// past moment and are not supposed to match today's graph, so widening as-is
// turns a silent gate into ~12 false violations on a required pre-commit and
// CI check, against the one file nearly every plan PR touches. Distinguishing
// current-state claims from historical ones is a design decision, not a regex
// edit.
describe("mermaid-set-coherence — KNOWN GAP: shapes the enumeration regex cannot see", () => {
  const GRAPH = [
    "```mermaid",
    "graph TB",
    "  NS01[NS-01: a]:::ready",
    "  NS22[NS-22: b]:::ready",
    "",
    "  classDef ready fill:#9f9,stroke:#0a0,color:#000",
    "```",
    "",
  ].join("\n");

  // Each prose line below is INCOHERENT with the graph above (it omits NS-22),
  // so a checker that saw the shape would report exactly one violation.
  const UNSEEN_SHAPES: Array<[label: string, prose: string]> = [
    ["brace form — the live corpus spelling", "The ready set **{NS-01}** shares no code paths."],
    ["bare brace form", "The ready set {NS-01} shares no code paths."],
    // Both endpoints are the SAME real node on purpose. A range spanning a
    // node that does not exist would be unseen for two reasons at once, and
    // this entry has to pin exactly one: the `.` character. Under either
    // widening — char class alone (list token `NS-01..NS-01`) or true range
    // expansion (`{NS-01}`) — the set is still incoherent with the graph, so
    // this entry must go red rather than pass for a second, unstated reason.
    ["range notation — `.` is outside the list char class", "The ready set (NS-01..NS-01) ships."],
    [
      "two-set brace line — the `shrinks from … to …` shape",
      "The ready set shrinks from **{NS-01, NS-22}** to **{NS-01}**.",
    ],
  ];

  it.each(UNSEEN_SHAPES)("does not currently see: %s", (_label, prose) => {
    withFile(`# Page\n\n${GRAPH}\n${prose}\n`, (file) => {
      expect(parseFile(file)).toEqual([]);
    });
  });

  it("control: the same incoherence IS caught in the paren form", () => {
    // Proves the fixtures above fail for their stated reason — the SHAPE —
    // and not because the graph, classDef, or adjective is wrong. Without
    // this, a graph typo would make all four pass vacuously.
    withFile(`# Page\n\n${GRAPH}\nThe ready set (NS-01) shares no code paths.\n`, (file) => {
      const violations = parseFile(file);
      expect(violations).toHaveLength(1);
      expect(violations[0].extra).toContain("NS22");
    });
  });
});

// Deliberately NOT inside the KNOWN GAP block above: this is a live defect on a
// shape the checker DOES see, and burying it among characterization tests would
// hide it from anyone skimming for real bugs.
describe("mermaid-set-coherence — LIVE DEFECT: a two-set line is judged on its first set", () => {
  const GRAPH = [
    "```mermaid",
    "graph TB",
    "  NS01[NS-01: a]:::ready",
    "  NS22[NS-22: b]:::ready",
    "",
    "  classDef ready fill:#9f9,stroke:#0a0,color:#000",
    "```",
    "",
  ].join("\n");

  it("silently keys on the FIRST set, so an after-state that matches still reports", () => {
    // The lazy `^.*?` prefix takes the earliest match, so a "becomes" line is
    // judged against its BEFORE state with no indication that a second set was
    // present — here the after-state (NS-01, NS-22) is exactly coherent with
    // the graph, and the line is still reported against the before-state.
    // This is also why widening to braces needs a two-set decision first:
    // every historical "shrinks from {A} to {B}" line would become a violation
    // keyed on A.
    withFile(
      `# Page\n\n${GRAPH}\nThe ready set (NS-01) becomes the ready set (NS-01, NS-22).\n`,
      (file) => {
        const violations = parseFile(file);
        expect(violations).toHaveLength(1);
        expect(violations[0].prose).toEqual(["NS-01"]);
      },
    );
  });
});
