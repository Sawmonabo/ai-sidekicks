// Direct suite for the shared fence tracker.
//
// Coverage was never the gap: perturbing advanceScanState already reddens the
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
  advanceScanState,
  blockquoteDepth,
  INITIAL_SCAN_STATE,
  stripBlockquotePrefix,
} from "../lib/markdown-fences.ts";
import type { ContainerEntry, MarkdownScanState, OpenFence } from "../lib/markdown-fences.ts";

/** Walk a document, returning the 0-based indices whose content is fenced. */
function fencedLineIndices(lines: string[]): number[] {
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  const fenced: number[] = [];
  lines.forEach((line, index) => {
    const result = advanceScanState(line, scanState);
    if (result.openFenceAtLineStart !== null && !result.isDelimiterLine) fenced.push(index);
    scanState = result.state;
  });
  return fenced;
}

/** A state holding one open fence and no containers. */
function fenceOpen(marker: string, length: number, infoString = ""): MarkdownScanState {
  return {
    containers: [],
    openFence: { marker, length, infoString, containerDepth: 0 },
    inParagraph: false,
  };
}

/** A list-item container entry, for stack assertions. */
function listItem(indent: number): ContainerEntry {
  return { kind: "listItem", indent };
}

/** Walk a container opener then a delimiter, returning the fence that opened. */
function fenceUnderContainer(containerLine: string, delimiterLine: string): OpenFence | null {
  const afterContainer = advanceScanState(containerLine, INITIAL_SCAN_STATE).state;
  return advanceScanState(delimiterLine, afterContainer).state.openFence;
}

describe("markdown-fences — opener indentation (CommonMark 0-3 spaces)", () => {
  it("opens on 0 through 3 leading spaces", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      const { state, isDelimiterLine } = advanceScanState(`${indent}\`\`\``, INITIAL_SCAN_STATE);
      expect(isDelimiterLine, `${JSON.stringify(indent)} must open a fence`).toBe(true);
      expect(state.openFence).toEqual({
        marker: "`",
        length: 3,
        infoString: "",
        containerDepth: 0,
      });
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
    const { state, isDelimiterLine } = advanceScanState("    ```", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(false);
    expect(state.openFence).toBeNull();
  });

  it("does NOT open on a leading tab — it expands past the three-space limit", () => {
    const { state, isDelimiterLine } = advanceScanState("\t```", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(false);
    expect(state.openFence).toBeNull();
  });
});

describe("markdown-fences — info strings (CommonMark 4.5)", () => {
  it("does NOT treat a backtick-bearing backtick info string as a delimiter", () => {
    // PR #207 round 4: ```` ```ts`x ```` is inline code. Opening a fence here
    // would exempt the following prose from the volatile-cite deny.
    const { state, isDelimiterLine } = advanceScanState("```ts`x", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(false);
    expect(state.openFence).toBeNull();
  });

  it("DOES allow a backtick inside a tilde info string", () => {
    // The complement — without it the rule above could be over-applied to
    // every marker and nothing would notice.
    const { state, isDelimiterLine } = advanceScanState("~~~ts`x", INITIAL_SCAN_STATE);
    expect(isDelimiterLine).toBe(true);
    expect(state.openFence).toEqual({
      marker: "~",
      length: 3,
      infoString: "ts`x",
      containerDepth: 0,
    });
  });

  it("opens on an ordinary info string", () => {
    expect(advanceScanState("```ts", INITIAL_SCAN_STATE).state.openFence).toEqual({
      marker: "`",
      length: 3,
      infoString: "ts",
      containerDepth: 0,
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
    expect(advanceScanState("~~~  mermaid", INITIAL_SCAN_STATE).state.openFence?.infoString).toBe(
      "  mermaid",
    );
  });
});

describe("markdown-fences — closer rules", () => {
  const OPEN_THREE = fenceOpen("`", 3);

  it("closes on the same marker at the opener's length", () => {
    expect(advanceScanState("```", OPEN_THREE).state.openFence).toBeNull();
  });

  it("closes on a LONGER run of the same marker", () => {
    expect(advanceScanState("````", OPEN_THREE).state.openFence).toBeNull();
  });

  it("does NOT close on a shorter run than the opener", () => {
    const openFour = fenceOpen("`", 4);
    const result = advanceScanState("```", openFour);
    expect(result.state.openFence).toEqual({
      marker: "`",
      length: 4,
      infoString: "",
      containerDepth: 0,
    });
    // Still a delimiter LINE — it is fence content that looks like a
    // delimiter, and callers must not treat it as prose.
    expect(result.isDelimiterLine).toBe(true);
  });

  it("does NOT close a backtick fence with tildes", () => {
    expect(advanceScanState("~~~", OPEN_THREE).state.openFence).toEqual({
      marker: "`",
      length: 3,
      infoString: "",
      containerDepth: 0,
    });
  });

  it("does NOT close when the tail carries non-whitespace", () => {
    expect(advanceScanState("``` js", OPEN_THREE).state.openFence).not.toBeNull();
  });

  it("DOES close when the tail is whitespace only", () => {
    expect(advanceScanState("```   ", OPEN_THREE).state.openFence).toBeNull();
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
    // A container is matched by reaching its content through SPACES, and the
    // prefix has to be verified rather than assumed: `abcd``` ` puts a
    // delimiter four columns in with four characters of prose in front of it.
    // Slicing blind reads that as the closer.
    //
    // What the line actually does is fail to match the item at all, which ends
    // the item and the fence with it. Nothing below is fence content: with the
    // container gone, the trailing `    ``` ` is four-space indented code at
    // root level, so it does not reopen anything either.
    expect(
      fencedLineIndices(["10. item", "", "    ```ts", "abcd```", "    code", "    ```", "after"]),
    ).toEqual([]);
  });

  it("ENDS a fence when the line leaves the list item it opened in", () => {
    // The dedent ends the item, and a fence cannot outlive its container: fence
    // content is never lazily continued (§5.1), so `back at root` is live prose
    // and so is everything after it. Through PR #273 round 1 this was a
    // disclosed BOUND — the stack froze while a fence was open, so the fence
    // ran to EOF and suppressed every check below it, the fail-open direction.
    // Eight fixtures in this file pinned that behaviour and disagreed with
    // cmark; the shape's corpus incidence is zero, so no tracked document
    // changed classification when it was fixed.
    expect(
      fencedLineIndices([
        "10. item",
        "",
        "    ```ts",
        "    code",
        "back at root",
        "more root prose",
      ]),
    ).toEqual([3]);
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
    // advanceScanState a synthetic delimiter that bypasses its own guard
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

describe("markdown-fences — paragraph interruption (CommonMark 0.31.2 §5.2)", () => {
  // Codex, PR #273 round 1. `2. text` under prose is paragraph text, not a
  // list: pushing a container for it moved the delimiter budget, so the
  // four-space backtick line below became a list-relative FENCE instead of
  // indented code, and every fence-aware check went silent over the live prose
  // after it. Suppression is the fail-open direction, so each case here is
  // paired with the complement that must still open a list.

  it("does not open a list for an ordered marker other than 1 under prose", () => {
    const fenced = fencedLineIndices([
      "Some ordinary prose.",
      "2. not a list — paragraph text",
      "    ```ts",
      "packages/x.ts:24",
      "    ```",
      "live prose after",
    ]);
    // No container, so the four-space delimiters are indented code and open
    // nothing: not one line is fenced, and the pin below EOF stays live.
    expect(fenced).toEqual([]);
  });

  it("suppresses nothing when the false container's content stays INSIDE it", () => {
    // The case above is weaker than it looks, and this one is why it needs a
    // partner. Disable the interruption rule entirely and `2.` does push a
    // container and the four-space line does open a false fence — but the pin
    // below it sits at column 0, which leaves the list item, and the
    // container-exit rule kills that fence before it suppresses anything. The
    // fixture reports `[]` either way and cannot tell a working rule from a
    // missing one.
    //
    // Indent the fence's content so it stays inside the container the false
    // item would create, and the exit rule can no longer mask the defect: the
    // suppression the round-1 finding was about becomes observable as a fenced
    // line. Measured — with the rule disabled this returns `[3]`.
    const fenced = fencedLineIndices([
      "Some ordinary prose.",
      "2. not a list — paragraph text",
      "    ```ts",
      "    packages/x.ts:24",
      "    ```",
      "live prose after",
    ]);
    expect(fenced).toEqual([]);
  });

  it("DOES open a list for `1.` under prose, which may interrupt", () => {
    // The complement. Without it the rule above could be over-applied to every
    // ordered marker and nothing would notice.
    const fenced = fencedLineIndices([
      "Some ordinary prose.",
      "1. a list that legitimately interrupts",
      "   ```ts",
      "   code",
      "   ```",
    ]);
    expect(fenced).toEqual([3]);
  });

  it("DOES open a list for a bullet under prose", () => {
    const fenced = fencedLineIndices([
      "Some ordinary prose.",
      "- a bullet interrupts a paragraph",
      "  ```ts",
      "  code",
      "  ```",
    ]);
    expect(fenced).toEqual([3]);
  });

  it("does not open a list for an EMPTY item under prose (Example 285)", () => {
    // Asserted on the container stack, not through a fence: an empty bullet's
    // content column is 2, which is a legal root-relative delimiter indent
    // either way, so fence classification cannot discriminate this rule.
    const afterProse = advanceScanState("Some ordinary prose.", INITIAL_SCAN_STATE).state;
    expect(afterProse.inParagraph).toBe(true);
    expect(advanceScanState("-", afterProse).state.containers).toEqual([]);
    // The complement: with no paragraph open, the same empty item DOES push.
    expect(advanceScanState("-", INITIAL_SCAN_STATE).state.containers).toEqual([listItem(2)]);
  });

  it("lets a non-1 marker continue a list that is already open", () => {
    // The restriction binds only a list's FIRST item. `1.` opens the list, so
    // `10.` continues it and its content column still governs — over-applying
    // the rule here would drop the container and mis-measure the fence.
    const fenced = fencedLineIndices([
      "1. first item",
      "10. second item",
      "    ```ts",
      "    code",
      "    ```",
    ]);
    expect(fenced).toEqual([3]);
  });

  it("re-arms after a blank line ends the paragraph", () => {
    const fenced = fencedLineIndices([
      "Some ordinary prose.",
      "",
      "2. now a real list — no paragraph to interrupt",
      "    ```ts",
      "    code",
      "    ```",
    ]);
    expect(fenced).toEqual([4]);
  });

  it("re-arms after a heading, which is not paragraph text", () => {
    const fenced = fencedLineIndices([
      "## A heading",
      "2. a list under a heading",
      "    ```ts",
      "    code",
      "    ```",
    ]);
    expect(fenced).toEqual([3]);
  });
});

describe("markdown-fences — blockquote containers (CommonMark 0.31.2 §5.1)", () => {
  // Codex, PR #273 round 1. Callers used to strip the `>` before the tracker
  // saw the line, so a quote exit was invisible and a quoted list's content
  // column leaked to root level.

  it("drops a quoted list's containers when the quote ends", () => {
    const fenced = fencedLineIndices([
      "> 10. quoted item",
      "    ```ts",
      "Spec-001:12",
      "    ```",
      "live prose after",
    ]);
    // The `10. ` container died with the blockquote, so the root-level
    // four-space delimiter is indented code, not a fence.
    expect(fenced).toEqual([]);
  });

  it("still honours the container while the quote continues", () => {
    // The complement: inside the quote the content column is real.
    const fenced = fencedLineIndices([
      "> 10. quoted item",
      ">     ```ts",
      ">     code",
      ">     ```",
    ]);
    expect(fenced).toEqual([2]);
  });

  it("kills a fence at the first line shallower than its opener (Example 237)", () => {
    // The third line RE-OPENS a fence at top level, which is why the shallower
    // line is processed normally rather than skipped.
    const fenced = fencedLineIndices(["> ```", "foo", "```", "after"]);
    // `foo` left the quote, so the quoted fence died and `foo` is live prose.
    // The third line then RE-OPENS a fence at top level — the example's whole
    // point — so `after` is fence content.
    expect(fenced).toEqual([3]);
  });

  it("treats a DEEPER delimiter inside a quoted fence as content", () => {
    const fenced = fencedLineIndices(["> ```md", ">> ```", "> still inside", "> ```", "after"]);
    expect(fenced).toEqual([1, 2]);
  });

  it("keeps a quoted paragraph open across an unquoted line (laziness)", () => {
    // CommonMark 0.31.2 §5.1 laziness: an unquoted line whose content is
    // paragraph continuation text continues the quoted paragraph. Laziness
    // applies only when the line starts no block of its own, so the fixture
    // uses ordinary prose — the marker case is the next test, and it goes the
    // other way.
    const afterLazyLine = advanceScanState(
      "still the same paragraph",
      advanceScanState("> Some quoted prose.", INITIAL_SCAN_STATE).state,
    ).state;
    expect(afterLazyLine.containers).toEqual([]);
    expect(afterLazyLine.inParagraph).toBe(true);
  });

  it("does NOT extend laziness to a line that starts a block", () => {
    // Round 1 asserted the opposite here, and the reference implementation
    // refuses it: `> Some quoted prose.` then `2. still...` renders as a
    // blockquote followed by `<ol start="2">`. A paragraph is interruptible
    // only where it is still REACHABLE — cmark tests whether the deepest
    // MATCHED container holds it — and the blockquote did not match this line,
    // so the marker is not interrupting anything and opens a start-2 list.
    // Laziness then never applies, because a block start was recognised.
    //
    // Keeping the flag across the exit made this fixture assert a fence that
    // does not exist, which is the fail-CLOSED direction (a container withheld,
    // delimiters measured from further left) — the reason it survived round 1.
    const fenced = fencedLineIndices([
      "> Some quoted prose.",
      "2. a list, not paragraph continuation",
      "    ```ts",
      "    Spec-001:12",
      "    ```",
    ]);
    expect(fenced).toEqual([3]);
  });

  it("treats a quoted delimiter inside an UNQUOTED fence as content", () => {
    const fenced = fencedLineIndices(["```md", "> ```", "still inside", "```", "after"]);
    expect(fenced).toEqual([1, 2]);
  });
});

describe("markdown-fences — interleaved containers (Codex, PR #273 round 2)", () => {
  // The three round-2 findings share one root cause: containers were modelled
  // as a global blockquote depth THEN a list stack, so `list -> blockquote`
  // order could not be expressed at all. These pin the order the old model
  // could not represent, plus the two rules that fell out of the same walk.

  it("opens a quoted fence nested INSIDE a list item", () => {
    // The finding verbatim: after `10. item`, this opener's `>` sits at column
    // four, so no strip-the-quote-prefix-first pass can see it. The fence never
    // opened, the volatile-cite scanner read the quoted example as live, and
    // mermaid coherence silently omitted the graph.
    expect(
      fencedLineIndices([
        "10. item",
        "",
        "    > ```mermaid",
        "    > graph TD",
        "    > ```",
        "",
        "    after",
      ]),
    ).toEqual([3]);
  });

  it("opens a fence whose list and quote markers share the opener's line", () => {
    expect(fencedLineIndices(["- > ```md", "- > text"])).toEqual([]);
    // The opener is line 0 and line 1 leaves the quote (a new item begins), so
    // no line is fence CONTENT — what matters is that line 0 opened at all.
    const afterOpener = advanceScanState("- > ```md", INITIAL_SCAN_STATE);
    expect(afterOpener.isDelimiterLine).toBe(true);
    expect(afterOpener.state.openFence?.containerDepth).toBe(2);
  });

  it("nests quote in list in quote, in that order", () => {
    const afterOpener = advanceScanState("> - > ```md", INITIAL_SCAN_STATE);
    expect(afterOpener.state.containers).toEqual([
      { kind: "blockquote" },
      listItem(2),
      { kind: "blockquote" },
    ]);
    expect(afterOpener.state.openFence?.containerDepth).toBe(3);
  });

  it("accepts a ZERO-PADDED start-one marker as a paragraph interrupter", () => {
    // The start number is the marker's VALUE: cmark lexes the digits and tests
    // `start != 1`, so `01.` is a start-1 marker. Matching the literal text
    // refused it, dropped the container, and mis-measured every delimiter under
    // it — here the four-space opener would have stayed indented code.
    expect(
      fencedLineIndices(["prose", "01. item", "", "    ```mermaid", "    graph TD", "    ```"]),
    ).toEqual([4]);
    // Padding is not a licence to renumber: the VALUE still has to be one.
    expect(fencedLineIndices(["prose", "02. item", "", "    ```mermaid", "    ```"])).toEqual([]);
  });

  it("clears paragraph state when a blockquote INTERRUPTS the paragraph", () => {
    // §5.1: a block quote can interrupt a paragraph, and the paragraph outside
    // it is not open inside it — so `10.` here starts a legal start-10 list
    // even though it could never have interrupted that paragraph directly.
    // Round 1 preserved the flag across every depth change, so this list was
    // refused and the five-space opener stayed a literal.
    expect(
      fencedLineIndices([
        "prose",
        "> 10. item",
        ">",
        ">     ```mermaid",
        ">     graph TD",
        ">     ```",
      ]),
    ).toEqual([4]);
  });
});

describe("markdown-fences — container walk invariants", () => {
  // Four behaviours the round-2 rewrite depends on that NO fixture pinned: a
  // mutation matrix over the new walk survived four arms, and a differential
  // search then produced a document distinguishing each. Every expectation
  // below is the answer commonmark 0.31.2 gives, not the answer this module
  // happened to give — a fixture written from the implementation pins whatever
  // it does, which is how the eight list-exit assertions got there.

  it("lets a blank line LEAVE a blockquote, while a list item survives one", () => {
    // The asymmetry is the spec's: a quote "can contain a blank line only if
    // it's marked with >", but an item's fence routinely follows one. Both
    // directions are load-bearing and they sit two lines apart in the walk, so
    // each is pinned against the other.
    const afterOpener = advanceScanState("> ```ts", INITIAL_SCAN_STATE).state;
    expect(afterOpener.openFence).not.toBeNull();
    const afterBlank = advanceScanState("", afterOpener);
    expect(afterBlank.openFenceAtLineStart).toBeNull();
    expect(afterBlank.state.containers).toEqual([]);
    // So the quoted delimiter below OPENS a second fence rather than closing
    // the first, and the blank line between them is live.
    expect(fencedLineIndices(["> ```ts", "", "> ```"])).toEqual([]);
    // The same shape under a list item keeps its fence, blank line included.
    expect(fencedLineIndices(["- ```ts", "", "  ```"])).toEqual([1]);
  });

  it("does not track paragraph state INSIDE a fence", () => {
    // Fence content is opaque, so a prose-shaped line in it opens no paragraph
    // — `inParagraph` describes the OUTER document. Nothing currently reads the
    // field across a fence boundary, so this is the only thing standing between
    // the invariant and a silent regression: the field is exported, and a
    // future consumer reading it would inherit whatever the last content line
    // happened to look like.
    const afterOpener = advanceScanState("```ts", INITIAL_SCAN_STATE).state;
    const afterContent = advanceScanState("const x = 1;", afterOpener).state;
    expect(afterContent.inParagraph).toBe(false);
  });

  it("clears the paragraph for EVERY container opened on the line, not just the first", () => {
    // `- ` may interrupt the prose above; inside that item the paragraph is
    // gone, so `10.` opens a legal start-10 list on the same line. Clearing the
    // flag only once left the second marker measured against the outer
    // paragraph, which refused it and dropped the content column from six to
    // two — the six-space opener then read as indented code.
    expect(
      fencedLineIndices(["prose", "- 10. item", "      ```ts", "      code", "      ```"]),
    ).toEqual([3]);
  });

  it("measures a list item's content column from the LINE, not from its marker", () => {
    // `  10. ` starts two columns in, so its content column is six: the
    // indentation before the marker is part of the width a continuation line
    // must reach. Measuring from the marker alone puts it at four.
    expect(fencedLineIndices(["  10. item", "", "      ```ts", "      code", "      ```"])).toEqual(
      [3],
    );
    // — and at four the line is indented code inside the item, not a fence.
    expect(fencedLineIndices(["  10. item", "", "    ```ts", "    code", "    ```"])).toEqual([]);
  });

  it("STOPS the container walk at the first unmatched entry", () => {
    // Leaving the outermost quote leaves everything nested inside it, however
    // well the inner markers would have matched on their own. Asserted on the
    // STEP rather than through `fencedLineIndices`: a walk that kept going
    // matches the inner containers against text no longer inside them, and the
    // damage shows up as a spurious fence OPEN — which that helper filters out
    // as a delimiter line, so the whole defect is invisible to it.
    const afterOpener = advanceScanState("> - > ```md", INITIAL_SCAN_STATE).state;
    const afterExit = advanceScanState("    ```ts", afterOpener);
    expect(afterExit.openFenceAtLineStart).toBeNull();
    // Four spaces at root level is indented CODE, not a delimiter. A walk that
    // continued past the failed quote would consume the item's two columns,
    // read `  ```ts` as a fence opener, and leave a stack holding the entry
    // that failed to match instead of the one that did.
    expect(afterExit.isDelimiterLine).toBe(false);
    expect(afterExit.state.openFence).toBeNull();
    expect(afterExit.state.containers).toEqual([]);
    // The same three containers, all matched, do keep the fence. Continuation
    // runs through the item's content column: a repeated `> - > ` would open a
    // NEW item and kill the fence.
    expect(fencedLineIndices(["> - > ```md", ">   > code", ">   > ```"])).toEqual([1]);
  });
});

describe("markdown-fences — quote-marker consumption inside the walk", () => {
  // `stripQuoteLevels` used to export the depth-limited strip, because the
  // tracker stripped a whole prefix at once and needed a way to strip EXACTLY
  // the fence's levels. The container walk consumes one marker at a time, so
  // the function had no callers left and was deleted with its three tests
  // rather than kept as a tested utility nothing uses. Its two load-bearing
  // behaviours are properties of the walk now, and are pinned as such.

  it("leaves a DEEPER marker in the content, so it cannot close the fence", () => {
    const afterOpener = advanceScanState("> ```md", INITIAL_SCAN_STATE).state;
    const deeper = advanceScanState(">> ```", afterOpener);
    // The fence's one quote level is consumed; the surplus `>` stays in the
    // content, fails the delimiter pattern, and is code.
    expect(deeper.isDelimiterLine).toBe(false);
    expect(deeper.state.openFence).not.toBeNull();
  });

  it("does not consume a space that no marker preceded", () => {
    // A root-level `    ``` ` read against a depth-1 fence must not lose a
    // space and become a valid three-space closer. Here the line matches no
    // blockquote at all, so the fence ends with its container instead — and
    // either way the line is not the fence's closer.
    const afterOpener = advanceScanState("> ```md", INITIAL_SCAN_STATE).state;
    const unquoted = advanceScanState("    ```", afterOpener);
    expect(unquoted.openFenceAtLineStart).toBeNull();
  });
});
