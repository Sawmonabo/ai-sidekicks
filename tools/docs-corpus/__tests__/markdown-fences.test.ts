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
//
// The container rules (task #83) are pinned here for a second reason: their
// population in the tracked corpus is ZERO, so no corpus sweep, recognition
// denominator, or enforced-lane survey can discriminate a correct container
// stack from a broken one. These fixtures are the only thing that does.

import { describe, it, expect } from "vitest";
import {
  advanceFenceState,
  blockquoteDepth,
  INITIAL_SCAN_STATE,
  stripBlockquotePrefix,
} from "../lib/markdown-fences.ts";
import type { MarkdownScanState, OpenFence } from "../lib/markdown-fences.ts";

/** Walk a document, returning the 0-based indices whose content is fenced. */
function fencedLineIndices(lines: string[]): number[] {
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  const fenced: number[] = [];
  lines.forEach((line, index) => {
    const openAtLineStart = scanState.openFence !== null;
    const result = advanceFenceState(stripBlockquotePrefix(line), scanState);
    if (openAtLineStart && !result.isDelimiterLine) fenced.push(index);
    scanState = result.state;
  });
  return fenced;
}

/** A state holding one open fence and no list containers. */
function fenceOpen(marker: string, length: number, infoString = ""): MarkdownScanState {
  return { containers: [], openFence: { marker, length, infoString } };
}

/** Walk a container opener then a delimiter, returning the fence that opened. */
function fenceUnderContainer(containerLine: string, delimiterLine: string): OpenFence | null {
  const afterContainer = advanceFenceState(containerLine, INITIAL_SCAN_STATE).state;
  return advanceFenceState(delimiterLine, afterContainer).state.openFence;
}

describe("markdown-fences — opener indentation (CommonMark 0-3 spaces)", () => {
  it("opens on 0 through 3 leading spaces", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      const { state, isDelimiterLine } = advanceFenceState(`${indent}\`\`\``, INITIAL_SCAN_STATE);
      expect(isDelimiterLine, `${JSON.stringify(indent)} must open a fence`).toBe(true);
      expect(state.openFence).toEqual({ marker: "`", length: 3, infoString: "" });
    }
  });

  it("does NOT open on four spaces — that is indented code content", () => {
    // PR #207 round 3: the earlier `\s*` treated an indented literal as an
    // opener, exempting the ordinary prose after it from the volatile-cite
    // deny and from §-cite extraction until the next delimiter.
    //
    // This is also the negative control for every container fixture below: the
    // SAME four spaces open a fence once a list item puts the content column
    // there, so what distinguishes them is container context and nothing else.
    const { state, isDelimiterLine } = advanceFenceState("    ```", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(false);
    expect(state.openFence).toBeNull();
  });

  it("does NOT open on a leading tab — it expands past the three-space limit", () => {
    const { state, isDelimiterLine } = advanceFenceState("\t```", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(false);
    expect(state.openFence).toBeNull();
  });
});

describe("markdown-fences — info strings (CommonMark 4.5)", () => {
  it("does NOT treat a backtick-bearing backtick info string as a delimiter", () => {
    // PR #207 round 4: ```` ```ts`x ```` is inline code. Opening a fence here
    // would exempt the following prose from the volatile-cite deny.
    const { state, isDelimiterLine } = advanceFenceState("```ts`x", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(false);
    expect(state.openFence).toBeNull();
  });

  it("DOES allow a backtick inside a tilde info string", () => {
    // The complement — without it the rule above could be over-applied to
    // every marker and nothing would notice.
    const { state, isDelimiterLine } = advanceFenceState("~~~ts`x", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(true);
    expect(state.openFence).toEqual({ marker: "~", length: 3, infoString: "ts`x" });
  });

  it("opens on an ordinary info string", () => {
    expect(advanceFenceState("```ts", INITIAL_SCAN_STATE).state.openFence).toEqual({
      marker: "`",
      length: 3,
      infoString: "ts",
    });
  });

  it("reports the info string VERBATIM, so consumers never re-match the delimiter", () => {
    // mermaid-set-coherence decides which KIND of fence opened. It used to ask
    // that of the raw line with its own `^ {0,3}` prefix — a second copy of the
    // indentation budget, which a container-relative opener then failed while
    // the tracker accepted it: the fence opened and the graph went uncollected.
    // Reading the info string keeps the delimiter's shape the tracker's business
    // alone.
    expect(fenceUnderContainer("10. item", "    ```mermaid")?.infoString).toBe("mermaid");
    expect(advanceFenceState("~~~  mermaid", INITIAL_SCAN_STATE).state.openFence?.infoString).toBe(
      "  mermaid",
    );
  });
});

describe("markdown-fences — closer rules", () => {
  const OPEN_THREE = fenceOpen("`", 3);

  it("closes on the same marker at the opener's length", () => {
    expect(advanceFenceState("```", OPEN_THREE).state.openFence).toBeNull();
  });

  it("closes on a LONGER run of the same marker", () => {
    expect(advanceFenceState("````", OPEN_THREE).state.openFence).toBeNull();
  });

  it("does NOT close on a shorter run than the opener", () => {
    const openFour = fenceOpen("`", 4);
    const result = advanceFenceState("```", openFour);
    expect(result.state.openFence).toEqual({ marker: "`", length: 4, infoString: "" });
    // Still a delimiter LINE — it is fence content that looks like a
    // delimiter, and callers must not treat it as prose.
    expect(result.isDelimiterLine).toBe(true);
  });

  it("does NOT close a backtick fence with tildes", () => {
    expect(advanceFenceState("~~~", OPEN_THREE).state.openFence).toEqual({
      marker: "`",
      length: 3,
      infoString: "",
    });
  });

  it("does NOT close when the tail carries non-whitespace", () => {
    expect(advanceFenceState("``` js", OPEN_THREE).state.openFence).not.toBeNull();
  });

  it("DOES close when the tail is whitespace only", () => {
    expect(advanceFenceState("```   ", OPEN_THREE).state.openFence).toBeNull();
  });
});

describe("markdown-fences — list containers (task #83)", () => {
  it("opens a four-space fence under a `10. ` item, whose content column is four", () => {
    // The rule the whole stack exists for. Through PR #270 this delimiter was
    // read as indented code, so a list-nested mermaid graph was never collected
    // (fail-silent) and a marker inside a list-nested example fence went live
    // (fail-closed).
    const fenced = fencedLineIndices([
      "10. A list item wide enough to shift the fence budget:",
      "",
      "    ```ts",
      "    const x = 1;",
      "    ```",
      "after",
    ]);
    expect(fenced).toEqual([3]);
  });

  it("opens a fence sharing the marker's line", () => {
    expect(fencedLineIndices(["- ```ts", "  const x = 1;", "  ```", "after"])).toEqual([1]);
  });

  it("requires whitespace after the marker before it shifts the budget", () => {
    // `- foo` is a list item and moves the content column to two, so a
    // four-space delimiter is two past it and opens. `-foo` is a paragraph:
    // the same delimiter stays four-space indented code. One character of
    // difference, opposite classifications.
    expect(fencedLineIndices(["- foo", "    ```ts", "    code", "    ```"])).toEqual([2]);
    expect(fencedLineIndices(["-foo", "    ```ts", "    code", "    ```"])).toEqual([]);
  });

  it("gives an EMPTY item the content column one space past its marker", () => {
    expect(fencedLineIndices(["-", "  ```ts", "  code", "  ```"])).toEqual([2]);
  });

  it("caps the content column when content sits five-plus spaces past the marker", () => {
    // CommonMark 5.2: five spaces after the marker means the content is
    // indented CODE inside the item, and the item's content column is one past
    // the marker — not six. A six-space delimiter is therefore four past the
    // content column, and stays code.
    expect(fencedLineIndices(["-     item", "", "      ```ts", "      code", "      ```"])).toEqual(
      [],
    );
    // Four spaces is under the cap, so that column DOES move to five.
    expect(fencedLineIndices(["-    item", "", "     ```ts", "     code", "     ```"])).toEqual([
      3,
    ]);
  });

  it("pushes a container per marker on a nested one-line opener", () => {
    expect(fencedLineIndices(["- - item", "    ```ts", "    code", "    ```"])).toEqual([2]);
  });

  it("does NOT treat a thematic break as a list item", () => {
    // `* * *` shares the bullet character. Pushing a container for it would
    // shift the budget for everything indented beneath — here, turning
    // four-space indented code into a fence.
    expect(fencedLineIndices(["* * *", "    ```ts", "    code", "    ```"])).toEqual([]);
  });

  it("pops a container on a non-blank line that dedents below its content column", () => {
    // Without the pop the container leaks past its item and every later
    // delimiter is measured from the wrong column: here the root-level opener
    // would be read as content of a container that ended lines ago.
    expect(fencedLineIndices(["- item", "```ts", "code", "```", "after"])).toEqual([2]);
  });

  it("does NOT pop on a blank line — an item's fence routinely follows one", () => {
    // The discriminator no corpus fixture provides: blank lines separate an
    // item's marker from its fence and sit INSIDE the fence, and popping on
    // either one loses the container. A tracker that popped here would fail to
    // open the fence at all; one that leaked would fail to close it.
    expect(
      fencedLineIndices(["10. item", "", "    ```ts", "    code", "", "    ```", "after"]),
    ).toEqual([3, 4]);
  });

  it("FREEZES containers while a fence is open", () => {
    // A marker-shaped line inside a fence is literal text. Pushing a container
    // for it would move the budget out from under the closer — the closer here
    // would match at column four, ending the fence early and exposing content
    // the author fenced deliberately.
    expect(fencedLineIndices(["```ts", "10. item", "    ```", "after"])).toEqual([1, 2, 3]);
  });

  it("does not reach the content column THROUGH text — only spaces count", () => {
    // Inside a container-nested fence the closer is found by slicing at the
    // content column, and the prefix has to be verified rather than assumed:
    // `abcd``` ` puts a delimiter at column four with four characters of prose
    // in front of it. Slicing blind reads that as the closer, ending the fence
    // three lines early and handing the real closer a fresh fence that
    // swallows everything after it.
    expect(
      fencedLineIndices(["10. item", "", "    ```ts", "abcd```", "    code", "    ```", "after"]),
    ).toEqual([3, 4]);
  });

  it("BOUND: a fence opened in a list item stays open past the item's end", () => {
    // Container EXIT is not modeled: the stack freezes while a fence is open,
    // so a dedent inside one neither pops the container nor closes the fence.
    // Measured over the tracked corpus at zero — of 597 fence spans, none is
    // unclosed, closes below its opener's indent, or holds an interior line
    // that dedents below it, so no real document can tell the difference. A
    // container-exit-aware tracker would end the fence at "back at root" and
    // leave the two lines below it live.
    expect(
      fencedLineIndices([
        "10. item",
        "",
        "    ```ts",
        "    code",
        "back at root",
        "more root prose",
      ]),
    ).toEqual([3, 4, 5]);
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

describe("markdown-fences — blockquoteDepth", () => {
  // Pinned at its own boundary, not through table-arity: the depth and the
  // strip share one prefix pattern, and a regression in either would otherwise
  // surface as a table that stopped being recognized.
  it("reports zero for an unquoted line", () => {
    expect(blockquoteDepth("| a | b |")).toBe(0);
    expect(blockquoteDepth("")).toBe(0);
  });

  it("counts each level, adjacent or space-separated", () => {
    expect(blockquoteDepth("> quoted")).toBe(1);
    expect(blockquoteDepth(">> nested")).toBe(2);
    expect(blockquoteDepth("> > spaced")).toBe(2);
    expect(blockquoteDepth(">>> three")).toBe(3);
  });

  it("agrees with stripBlockquotePrefix on what counts as a marker", () => {
    // Same three-space budget: a four-space-indented `>` is indented code, so
    // the strip leaves it in place and the depth must stay 0 — the two must
    // never disagree about where the container prefix ends.
    expect(blockquoteDepth("   > three spaces")).toBe(1);
    expect(stripBlockquotePrefix("   > three spaces")).toBe("three spaces");
    expect(blockquoteDepth("    > four spaces")).toBe(0);
    expect(stripBlockquotePrefix("    > four spaces")).toBe("    > four spaces");
    expect(blockquoteDepth("\t> tab")).toBe(0);
  });

  it("counts a marker with no following space", () => {
    expect(blockquoteDepth(">no space after marker")).toBe(1);
    expect(blockquoteDepth(">")).toBe(1);
  });

  it("stops at the first non-marker, ignoring a later `>` in content", () => {
    expect(blockquoteDepth("> a > b")).toBe(1);
    expect(blockquoteDepth("prose > not a quote")).toBe(0);
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
