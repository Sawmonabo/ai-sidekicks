// Direct suite for the shared fence tracker.
//
// Coverage was never the gap: perturbing advanceFenceState already reddens the
// suite — but via 13 of 15 failures spread across label-cite and
// cite-target-existence, two modules that merely CONSUME it. The failure text
// then describes a heading that went uncollected or a cite that went
// unverified, and the reader has to work backwards to a fence rule. What
// follows pins each rule at its own boundary so a regression names the rule it
// broke (CAT-10 mutation pass 3: "the gap is diagnosability, not coverage").
//
// Every rule below traces to a specific correction — the fence logic was fixed
// four times across PR #207 rounds 2-4, which is why the rules are pinned
// individually rather than as one happy-path walk.

import { describe, it, expect } from "vitest";
import { advanceFenceState, stripBlockquotePrefix } from "../lib/markdown-fences.ts";
import type { OpenFenceState } from "../lib/markdown-fences.ts";

/** Walk a document, returning the 0-based indices whose content is fenced. */
function fencedLineIndices(lines: string[]): number[] {
  let openFence: OpenFenceState = null;
  const fenced: number[] = [];
  lines.forEach((line, index) => {
    const openAtLineStart = openFence !== null;
    const result = advanceFenceState(stripBlockquotePrefix(line), openFence);
    if (openAtLineStart && !result.isDelimiterLine) fenced.push(index);
    openFence = result.openFence;
  });
  return fenced;
}

describe("markdown-fences — opener indentation (CommonMark 0-3 spaces)", () => {
  it("opens on 0 through 3 leading spaces", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      const { openFence, isDelimiterLine } = advanceFenceState(`${indent}\`\`\``, null);
      expect(isDelimiterLine, `${JSON.stringify(indent)} must open a fence`).toBe(true);
      expect(openFence).toEqual({ marker: "`", length: 3 });
    }
  });

  it("does NOT open on four spaces — that is indented code content", () => {
    // PR #207 round 3: the earlier `\s*` treated an indented literal as an
    // opener, exempting the ordinary prose after it from the volatile-cite
    // deny and from §-cite extraction until the next delimiter.
    const { openFence, isDelimiterLine } = advanceFenceState("    ```", null);
    expect(isDelimiterLine).toBe(false);
    expect(openFence).toBeNull();
  });

  it("does NOT open on a leading tab — it expands past the three-space limit", () => {
    const { openFence, isDelimiterLine } = advanceFenceState("\t```", null);
    expect(isDelimiterLine).toBe(false);
    expect(openFence).toBeNull();
  });
});

describe("markdown-fences — info strings (CommonMark 4.5)", () => {
  it("does NOT treat a backtick-bearing backtick info string as a delimiter", () => {
    // PR #207 round 4: ```` ```ts`x ```` is inline code. Opening a fence here
    // would exempt the following prose from the volatile-cite deny.
    const { openFence, isDelimiterLine } = advanceFenceState("```ts`x", null);
    expect(isDelimiterLine).toBe(false);
    expect(openFence).toBeNull();
  });

  it("DOES allow a backtick inside a tilde info string", () => {
    // The complement — without it the rule above could be over-applied to
    // every marker and nothing would notice.
    const { openFence, isDelimiterLine } = advanceFenceState("~~~ts`x", null);
    expect(isDelimiterLine).toBe(true);
    expect(openFence).toEqual({ marker: "~", length: 3 });
  });

  it("opens on an ordinary info string", () => {
    expect(advanceFenceState("```ts", null).openFence).toEqual({ marker: "`", length: 3 });
  });
});

describe("markdown-fences — closer rules", () => {
  const OPEN_THREE: OpenFenceState = { marker: "`", length: 3 };

  it("closes on the same marker at the opener's length", () => {
    expect(advanceFenceState("```", OPEN_THREE).openFence).toBeNull();
  });

  it("closes on a LONGER run of the same marker", () => {
    expect(advanceFenceState("````", OPEN_THREE).openFence).toBeNull();
  });

  it("does NOT close on a shorter run than the opener", () => {
    const openFour: OpenFenceState = { marker: "`", length: 4 };
    const result = advanceFenceState("```", openFour);
    expect(result.openFence).toEqual(openFour);
    // Still a delimiter LINE — it is fence content that looks like a
    // delimiter, and callers must not treat it as prose.
    expect(result.isDelimiterLine).toBe(true);
  });

  it("does NOT close a backtick fence with tildes", () => {
    expect(advanceFenceState("~~~", OPEN_THREE).openFence).toEqual(OPEN_THREE);
  });

  it("does NOT close when the tail carries non-whitespace", () => {
    expect(advanceFenceState("``` js", OPEN_THREE).openFence).toEqual(OPEN_THREE);
  });

  it("DOES close when the tail is whitespace only", () => {
    expect(advanceFenceState("```   ", OPEN_THREE).openFence).toBeNull();
  });
});

describe("markdown-fences — stripBlockquotePrefix", () => {
  it("strips one level, with or without the optional single space", () => {
    expect(stripBlockquotePrefix("> ```md")).toBe("```md");
    expect(stripBlockquotePrefix(">no space after marker")).toBe("no space after marker");
    expect(stripBlockquotePrefix(">")).toBe("");
  });

  it("strips nested levels, adjacent or space-separated", () => {
    expect(stripBlockquotePrefix(">> nested")).toBe("nested");
    expect(stripBlockquotePrefix("> > spaced")).toBe("spaced");
  });

  it("strips up to three spaces before a marker but not four, and not a tab", () => {
    // Same CommonMark budget as the opener rule; stripping past it would hand
    // advanceFenceState a synthetic delimiter that bypasses its own guard
    // (PR #207 round 4).
    expect(stripBlockquotePrefix("   > three spaces")).toBe("three spaces");
    expect(stripBlockquotePrefix("    > four spaces")).toBe("    > four spaces");
    expect(stripBlockquotePrefix("\t> tab")).toBe("\t> tab");
  });
});

describe("markdown-fences — document walk", () => {
  it("keeps a nested shorter fence from closing the outer block", () => {
    const fenced = fencedLineIndices(["````md", "```", "## Heading", "```", "````", "after"]);
    expect(fenced).toEqual([2]);
  });

  it("does not let an info-string line reopen a fence over following prose", () => {
    // The PR #207 round-2 regression in its original shape: the naive toggle
    // mis-closed on the info-string line, so the REAL closer reopened the
    // fence and swallowed every following line.
    const fenced = fencedLineIndices(["```ts", "const x = 1;", "```", "real prose", "more prose"]);
    expect(fenced).toEqual([1]);
  });

  it("treats a quoted fence as a fence, so quoted examples stay hidden", () => {
    const fenced = fencedLineIndices(["> ```md", "> ## quoted heading", "> ```", "after"]);
    expect(fenced).toEqual([1]);
  });
});
