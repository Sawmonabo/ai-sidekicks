// Corroboration of the shared fence tracker against the CommonMark reference
// parser (jgm's own JS port, pinned at the 0.31.2 the tracker is written to).
//
// WHAT THIS TEST IS FOR, AND WHAT IT IS NOT. The spec TEXT is the authority
// here; `commonmark@0.31.2` is a second opinion, nothing more. Where the two
// disagree the spec adjudicates and the divergence is recorded in
// ACCEPTED_DIVERGENCES below with its reason — the oracle never silently
// rewrites what the tracker is supposed to do. What it buys is the class of
// error a hand-written fixture cannot catch: a shape neither the author nor a
// reviewer thought to write down. `markdown-fences.test.ts` pins each rule at
// its own boundary and stays the primary suite; this one asks an independent
// implementation whether the ensemble agrees.
//
// THE COMPARABLE QUANTITY is line MEMBERSHIP in a fenced code block, which is
// the only thing both sides can express. The tracker is a line-at-a-time state
// machine with no AST; the parser has an AST with no per-line verdict. So each
// side is reduced to a set of 1-based line numbers: for the tracker, lines
// where a fence is in force or that are themselves delimiters; for the parser,
// every line spanned by a fenced `code_block`'s `sourcepos`.
//
// WHY THE SUBSET IS BOUNDED. The tracker models CommonMark's container
// machinery (blockquotes and list items) and fenced code, and nothing else —
// no setext headings, no HTML blocks, no link reference definitions. Fixtures
// stay inside that subset on purpose: outside it a divergence would say
// nothing about a defect, only that the tracker declines to model a construct
// it never claimed to.

import { describe, it, expect } from "vitest";
import { Parser } from "commonmark";
import { advanceScanState, INITIAL_SCAN_STATE } from "../lib/markdown-fences.ts";
import type { MarkdownScanState } from "../lib/markdown-fences.ts";

/**
 * A document that is nothing but a fenced block. Used to prove the oracle can
 * still see fencedness at all before any comparison is trusted.
 */
const FENCE_CANARY = "```ts\ncontent\n```\n";

/**
 * Lines a fenced `code_block` spans, per the reference parser.
 *
 * Fencedness is read from the PUBLIC `info` accessor, not the private
 * `_isFenced` flag the parser uses internally: `info` is `null` on
 * construction and assigned in exactly one place — the fenced branch of
 * `code_block.finalize` — so `info !== null` is precisely fencedness, and the
 * committed test does not reach into the dependency's internals to get it.
 */
function collectFencedLines(source: string): Set<number> {
  const walker = new Parser().parse(source).walker();
  const lines = new Set<number>();
  let step = walker.next();
  while (step !== null) {
    const { entering, node } = step;
    if (entering && node.type === "code_block" && node.info !== null) {
      const [[startLine], [endLine]] = node.sourcepos;
      for (let line = startLine; line <= endLine; line++) lines.add(line);
    }
    step = walker.next();
  }
  return lines;
}

let oracleProven = false;

/**
 * Refuse to compare against an oracle that has gone blind.
 *
 * This is the failure that makes a green suite meaningless: if the fencedness
 * discriminator ever stops working — a dependency bump renames `info`, or the
 * sentinel changes from `null` — every call returns the EMPTY set, the empty
 * set diverges from nothing the tracker could report on a document with no
 * fences, and a suite of mostly-small fixtures goes quiet instead of red. So
 * the guard runs before the FIRST comparison and throws, rather than letting
 * per-fixture assertions aggregate a verdict from an oracle that answered
 * nothing.
 */
// Takes its collector as a parameter for one reason: so the suite can inject a
// blind one and prove the guard actually FIRES. A guard exercised only in the
// passing direction is the same false-clean it exists to prevent.
function proveOracleStillSeesFences(collect: (source: string) => Set<number>): void {
  if (collect(FENCE_CANARY).size === 0) {
    throw new Error(
      "commonmark oracle reported NO fenced lines for a document that is nothing but a " +
        "fenced block. The fencedness discriminator has drifted (see commonmark.d.ts) — " +
        "refusing to compare, because an oracle returning the empty set agrees with " +
        "every possible tracker.",
    );
  }
}

function oracleFencedLines(source: string): Set<number> {
  if (!oracleProven) {
    proveOracleStillSeesFences(collectFencedLines);
    oracleProven = true;
  }
  return collectFencedLines(source);
}

/** The same quantity, from the tracker under test. */
function trackerFencedLines(source: string): Set<number> {
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  const lines = new Set<number>();
  splitLines(source).forEach((line, index) => {
    const result = advanceScanState(line, scanState);
    if (result.openFenceAtLineStart !== null || result.isDelimiterLine) lines.add(index + 1);
    scanState = result.state;
  });
  return lines;
}

/**
 * Split into the lines the PARSER numbers. A trailing newline terminates the
 * last line rather than starting an empty one, and counting a phantom line
 * would shift every comparison after it by one.
 */
function splitLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sorted(lines: Set<number>): number[] {
  return [...lines].sort((left, right) => left - right);
}

interface Fixture {
  readonly name: string;
  readonly source: string;
}

/**
 * Shapes inside the modelled subset. Each is a container arrangement the
 * tracker makes a claim about — the quoted, listed, and interleaved forms that
 * the container-stack rewrite exists to express, plus the delimiter-grammar
 * rules that predate it.
 */
const FIXTURES: Fixture[] = [
  { name: "top-level fence", source: "before\n```ts\ncode\n```\nafter\n" },
  { name: "tilde fence", source: "before\n~~~\ncode\n~~~\nafter\n" },
  { name: "fence with info string", source: "```ts title=x\ncode\n```\n" },
  { name: "indented code is NOT a fence", source: "para\n\n    indented code\n\nafter\n" },
  { name: "four-space delimiter is indented code", source: "para\n\n    ```ts\n    code\n" },
  { name: "quoted fence", source: "> ```\n> code\n> ```\nafter\n" },
  { name: "nested quoted fence", source: "> > ```\n> > code\n> > ```\nafter\n" },
  {
    // The blockquote marker's single optional space is PART of the marker, so
    // three further spaces still sit inside the delimiter's legal indent. Leave
    // that space for the content and the same line reads as four-space indented
    // code instead — this fixture is the one that notices.
    name: "quoted fence at the three-space indent limit",
    source: ">    ```ts\n>    code\n>    ```\nafter\n",
  },
  {
    name: "spec example 237 — fence dies leaving its blockquote",
    source: "> ```\nfoo\n```\n",
  },
  { name: "fence in a list item", source: "1. item\n\n   ```ts\n   code\n   ```\n" },
  { name: "fence in a bullet item", source: "- item\n\n  ```ts\n  code\n  ```\n" },
  {
    name: "list then blockquote — the interleaved order the rewrite exists for",
    source: "10. item\n\n    > ```mermaid\n    > graph TD\n    > ```\n",
  },
  {
    name: "quote then list — the other interleaving",
    source: "> 1. item\n>\n>    ```ts\n>    code\n>    ```\n",
  },
  {
    name: "fence dies leaving a list item",
    source: "10. item\n\n    ```ts\n    code\nback at root\n    ```\n",
  },
  { name: "unclosed fence runs to EOF", source: "before\n```ts\ncode\nmore code\n" },
  {
    name: "backtick in a backtick info string is not a delimiter",
    source: "prose\n```ts`x\nstill prose\n",
  },
  { name: "tilde cannot close a backtick fence", source: "```\ncode\n~~~\nstill code\n```\n" },
  { name: "closer with trailing text is content", source: "```\ncode\n``` trailing\n```\n" },
  { name: "longer closer closes a shorter opener", source: "```\ncode\n`````\nafter\n" },
  { name: "shorter closer does not close", source: "`````\ncode\n```\nstill code\n`````\n" },
  { name: "blank lines inside a fence", source: "```\n\ncode\n\n```\nafter\n" },
  { name: "ordered marker other than 1 under prose", source: "prose\n2. text\n    ```ts\n    x\n" },
  { name: "`1.` under prose may interrupt", source: "prose\n1. item\n   ```ts\n   code\n   ```\n" },
  { name: "bullet under prose may interrupt", source: "prose\n- item\n  ```ts\n  code\n  ```\n" },
  { name: "thematic break is not a list marker", source: "* * *\n```ts\ncode\n```\n" },
  { name: "three-space delimiter indent is legal", source: "prose\n\n   ```ts\n   code\n   ```\n" },
  { name: "no fences at all", source: "# heading\n\nordinary prose\n\nmore prose\n" },
  { name: "empty document", source: "" },
];

/**
 * Fixtures where the tracker is EXPECTED to disagree with the reference
 * parser, each with the reason the spec text (not the oracle) settles it.
 *
 * Empty today. It exists so that a future divergence has to be adjudicated and
 * written down rather than absorbed by loosening an assertion — and every entry
 * is proven live: a name here that no longer diverges fails the suite below,
 * so a fixed divergence cannot linger as a permanent exemption.
 */
const ACCEPTED_DIVERGENCES = new Map<string, string>();

describe("commonmark oracle — dependency facts this tree relies on", () => {
  // The ambient declaration in commonmark.d.ts asserts both of these. They are
  // claims about a dependency, so they get proven rather than commented.

  it("populates sourcepos with no options object", () => {
    const parsed = new Parser().parse(FENCE_CANARY);
    const walker = parsed.walker();
    let step = walker.next();
    let sawCodeBlock = false;
    while (step !== null) {
      if (step.entering && step.node.type === "code_block") {
        expect(step.node.sourcepos).toEqual([
          [1, 1],
          [3, 3],
        ]);
        sawCodeBlock = true;
      }
      step = walker.next();
    }
    expect(sawCodeBlock).toBe(true);
  });

  it("discriminates fenced from indented via the public `info` accessor", () => {
    const fencedInfo: (string | null)[] = [];
    const indentedInfo: (string | null)[] = [];
    for (const [source, sink] of [
      ["```\ncode\n```\n", fencedInfo],
      ["```ts\ncode\n```\n", fencedInfo],
      ["    indented code\n", indentedInfo],
    ] as const) {
      const walker = new Parser().parse(source).walker();
      let step = walker.next();
      while (step !== null) {
        if (step.entering && step.node.type === "code_block") sink.push(step.node.info);
        step = walker.next();
      }
    }
    // Fenced blocks always carry a string (empty when there is no info
    // string); indented blocks never do. Both polarities, so the
    // discriminator cannot pass by answering one way for everything.
    expect(fencedInfo).toEqual(["", "ts"]);
    expect(indentedInfo).toEqual([null]);
  });
});

describe("commonmark oracle — the comparison is live", () => {
  // A clean corroboration result is worth nothing unless this harness can go
  // red. Both halves are proven to fail on input known to be wrong.

  it("reports a divergence when the tracker under comparison is wrong", () => {
    const blindTracker = (): Set<number> => new Set<number>();
    const source = "```ts\ncode\n```\n";
    expect(sorted(oracleFencedLines(source))).toEqual([1, 2, 3]);
    expect(sorted(blindTracker())).not.toEqual(sorted(oracleFencedLines(source)));
  });

  it("refuses to compare when the oracle reports nothing on the canary", () => {
    // Drives the REAL guard with a blind collector, so this pins the shipped
    // failure path rather than a locally-thrown lookalike. A discriminator that
    // has drifted returns the empty set for every input, including the canary.
    const blindCollector = (): Set<number> => new Set<number>();
    expect(() => proveOracleStillSeesFences(blindCollector)).toThrow(/reported NO fenced lines/);
  });

  it("sees the canary through the real guard", () => {
    expect(() => proveOracleStillSeesFences(collectFencedLines)).not.toThrow();
    expect(oracleFencedLines(FENCE_CANARY).size).toBeGreaterThan(0);
  });
});

describe("commonmark oracle — fence membership agrees with the reference parser", () => {
  for (const fixture of FIXTURES) {
    const divergenceReason = ACCEPTED_DIVERGENCES.get(fixture.name);
    it(`${fixture.name}${divergenceReason === undefined ? "" : " (accepted divergence)"}`, () => {
      const oracle = sorted(oracleFencedLines(fixture.source));
      const tracker = sorted(trackerFencedLines(fixture.source));
      if (divergenceReason === undefined) {
        expect(tracker).toEqual(oracle);
      } else {
        // A recorded divergence must still BE one. Otherwise the entry is a
        // stale exemption quietly weakening the fixture it names.
        expect(tracker).not.toEqual(oracle);
      }
    });
  }

  it("exercises both polarities — some fixtures fenced, some not", () => {
    // Guards the whole block against the degenerate pass where every fixture
    // happens to contain no fences and `[] === []` everywhere.
    const perFixture = FIXTURES.map((fixture) => oracleFencedLines(fixture.source).size);
    expect(perFixture.filter((size) => size > 0).length).toBeGreaterThan(15);
    expect(perFixture.filter((size) => size === 0).length).toBeGreaterThan(0);
  });

  it("names only fixtures that exist in ACCEPTED_DIVERGENCES", () => {
    const names = new Set(FIXTURES.map((fixture) => fixture.name));
    for (const name of ACCEPTED_DIVERGENCES.keys()) expect(names).toContain(name);
  });
});
