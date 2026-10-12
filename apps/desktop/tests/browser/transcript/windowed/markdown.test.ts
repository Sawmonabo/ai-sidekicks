// A long reply drawn as a window over its blocks, against the same reply drawn whole, in the
// engine that lays them out. The claims are about where text lands, how many elements stay
// mounted, what a selection keeps, where the reader's block stays when the text size changes and
// what each painted frame shows while the parser answers late, none of which a DOM shim can
// answer. Every frame a case lets pass is checked for a block drawn before its tree: an empty box
// where a block belongs, or markdown's own syntax as text.

import { act } from "@testing-library/react";
import { fromDom } from "hast-util-from-dom";
import { describe, expect, it, vi } from "vitest";

import { drawnTreeText } from "#renderer/components/Markdown/drawn-text.js";
import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import type { MarkdownParseAnswer } from "#renderer/components/Markdown/worker/messages.js";
import { longReplyMarkdown } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { collectGarbage } from "#test/helpers/garbage-collection.js";
import {
  drawnBlocks,
  flingShowingSpacers,
  letFramePaint,
  mountBodies,
  SCROLLER_HEIGHT_PX,
  scrollTo,
  scrollToEnd,
  settleFrames,
  textEnds,
  unformattedDraw,
} from "./reply.js";

/** How far apart two renderings of one line may land and still be the same pixel. */
const SAME_LINE_TOLERANCE_PX = 0.5;
/** A reply of one-line paragraphs, long enough to be windowed, each block a line tall. */
const SHORT_BLOCK_COUNT = 2_000;
/** The screens a fling must travel for its frames to have crossed the window's edge many times. */
const FLING_MINIMUM_SCREENS = 3;

/** Half-screen steps a reader reads upward in, from the end of a reply drawn cold. */
const READ_UP_STEPS = 8;

/**
 * A reply no other case draws, so no block's geometry is remembered from one, of prose and code
 * whose drawn heights the estimates miss: paragraphs wrap where the estimate does not, and a code
 * block's frame is not the two lines it counts.
 */
/** One sentence of the cold reply's prose, repeated to vary its paragraphs' lengths. */
const COLD_SENTENCE = "a sentence the reader is reading upward through, ";

function coldReplyMarkdown(): string {
  const blocks: string[] = [];
  for (let index = 0; index < 160; index += 1) {
    const label = String(index);
    const code = [`const heldPlace${label} = ${label};`, `use(heldPlace${label});`];
    const sentences = COLD_SENTENCE.repeat(1 + (index % 5));
    blocks.push(
      index % 4 === 3
        ? ["```ts", ...code, "```"].join("\n")
        : `Held place ${label}: ${sentences}end.`,
    );
  }
  return blocks.join("\n\n");
}

/** The first drawn block reaching below the middle of the scroller's box. */
function blockAtMiddleOf(scroller: HTMLElement, windowedBody: HTMLElement): Element {
  const box = scroller.getBoundingClientRect();
  const middlePx = box.top + box.height / 2;
  const block = [...drawnBlocks(windowedBody).entries()]
    .sort(([index], [otherIndex]) => index - otherIndex)
    .map(([, wrapper]) => wrapper)
    .find((wrapper) => wrapper.getBoundingClientRect().bottom > middlePx);
  if (block === undefined) {
    throw new Error("no drawn block reaches below the middle of the box");
  }
  return block;
}

/** How long a late parser holds each answer, in milliseconds: several frames at any rate. */
const LATE_ANSWER_MS = 60;

/**
 * Checks every frame painted from now until `stop` with `find`, and answers what each frame that
 * `find` faulted showed.
 */
function recordFrames(find: () => string | undefined): { readonly stop: () => readonly string[] } {
  const found: string[] = [];
  let isRecording = true;
  const onFrame = (): void => {
    if (!isRecording) {
      return;
    }
    const fault = find();
    if (fault !== undefined) {
      found.push(fault);
    }
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  return {
    stop: () => {
      isRecording = false;
      return found;
    },
  };
}

/**
 * Fills the shared tree cache past its cap with other replies' blocks, each led by `label`: about
 * 4,900 blocks, each charged its text and its tree's buffer, some 660 bytes, which pass 2 MiB.
 */
async function fillTreeCache(label: string): Promise<void> {
  const blocks = longReplyMarkdown(400_000)
    .split("\n\n")
    .map((block, index) => `${label} ${String(index)}: ${block}`);
  await act(async () => {
    await Promise.all(
      blocks.map(
        (block) =>
          new Promise<void>((resolve) => {
            appMarkdownTrees.requestSettledBlock(block, "", () => {
              resolve();
            });
          }),
      ),
    );
  });
}

/** An element's first line, as its top below the body's top. */
function firstLineOffsetPx(element: Element | null | undefined, body: HTMLElement): number {
  if (element === null || element === undefined) {
    throw new Error("the whole reply drew no element there");
  }
  return element.getBoundingClientRect().top - body.getBoundingClientRect().top;
}

/** The drawn blocks that hold no element: drawn before their trees, as a blank box or none. */
function blocksDrawnEmpty(windowedBody: HTMLElement): string[] {
  return [...drawnBlocks(windowedBody)]
    .filter(([, wrapper]) => wrapper.firstElementChild === null)
    .map(([index]) => `block ${String(index)}`);
}

/** The windowed body's spacers: its children that hold the room of blocks it does not draw. */
function blockSpacersOf(windowedBody: HTMLElement): HTMLElement[] {
  return [
    ...windowedBody.querySelectorAll<HTMLElement>(
      `:scope > :not([${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}])`,
    ),
  ];
}

describe("browser — a long reply drawn as a window over its blocks", () => {
  it("puts every drawn element where the whole reply puts it, at the same height", async () => {
    const { scroller, windowedBody, flowBody } = await mountBodies(longReplyMarkdown(24_000), {
      isComplete: true,
      drawsFlowBody: true,
    });
    if (flowBody === undefined) {
      throw new Error("the whole reply did not mount");
    }
    // A block can draw several elements, so each is paired with the whole reply's by its place
    // among all the reply's elements. Scrolled from the top in steps shorter than the viewport,
    // every block above a drawn one has been drawn, and counted, by the time it is compared.
    const elementCountByBlock = new Map<number, number>();
    const firstElementIndexOf = (blockIndex: number): number => {
      let elementIndex = 0;
      for (let earlier = 0; earlier < blockIndex; earlier += 1) {
        const count = elementCountByBlock.get(earlier);
        if (count === undefined) {
          throw new Error(`block ${String(earlier)} was never drawn`);
        }
        elementIndex += count;
      }
      return elementIndex;
    };
    let checkedElements = 0;
    for (
      let scrollTop = 0;
      scrollTop < scroller.scrollHeight;
      scrollTop += SCROLLER_HEIGHT_PX / 2
    ) {
      await scrollTo(scroller, scrollTop);
      const drawn = drawnBlocks(windowedBody);
      for (const [index, wrapper] of drawn) {
        elementCountByBlock.set(index, wrapper.children.length);
      }
      for (const [index, wrapper] of drawn) {
        const firstElementIndex = firstElementIndexOf(index);
        for (const [offset, element] of [...wrapper.children].entries()) {
          const windowedOffset = firstLineOffsetPx(element, windowedBody);
          const flowOffset = firstLineOffsetPx(
            flowBody.children[firstElementIndex + offset],
            flowBody,
          );
          expect(
            Math.abs(windowedOffset - flowOffset),
            `block ${String(index)} element ${String(offset)} at scroll ${String(scrollTop)}: windowed ${String(windowedOffset)}, whole ${String(flowOffset)}`,
          ).toBeLessThanOrEqual(SAME_LINE_TOLERANCE_PX);
          checkedElements += 1;
        }
      }
    }
    expect(checkedElements).toBeGreaterThan(flowBody.children.length);
    expect(
      Math.abs(
        windowedBody.getBoundingClientRect().height - flowBody.getBoundingClientRect().height,
      ),
    ).toBeLessThanOrEqual(SAME_LINE_TOLERANCE_PX);
  });

  it("shows no spacer in any frame of the fastest fling through a reply of one-line blocks", async () => {
    const reply = Array.from({ length: SHORT_BLOCK_COUNT }, (_, index) => `Line ${String(index)}.`);
    const { scroller, windowedBody } = await mountBodies(reply.join("\n\n"), {
      isComplete: true,
      drawsFlowBody: false,
    });

    const shownPxByFrame = await flingShowingSpacers(
      scroller,
      `[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}]`,
      () => blockSpacersOf(windowedBody),
    );

    // The controls: the fling crossed screens of blocks the window had not drawn, and the window
    // still holds the room of the blocks it does not draw.
    expect(scroller.scrollTop).toBeGreaterThan(FLING_MINIMUM_SCREENS * SCROLLER_HEIGHT_PX);
    expect(blockSpacersOf(windowedBody).length).toBeGreaterThan(0);
    expect(shownPxByFrame).toEqual([]);
  });

  it("keeps its mounted elements bounded as a streaming reply grows from 10 KB to 200 KB", async () => {
    const { scroller, windowedBody, handle } = await mountBodies(longReplyMarkdown(10_000), {
      isComplete: false,
      drawsFlowBody: false,
    });
    const elementCounts = new Map<number, number>();
    for (const size of [10_000, 50_000, 100_000, 200_000]) {
      act(() => {
        handle.setText?.(longReplyMarkdown(size));
      });
      await settleFrames();
      // The reader follows the tail, where a streaming reply grows.
      await scrollToEnd(scroller);
      elementCounts.set(size, windowedBody.querySelectorAll("*").length);
    }
    const atTenKilobytes = elementCounts.get(10_000) ?? 0;
    const atTwoHundredKilobytes = elementCounts.get(200_000) ?? Number.POSITIVE_INFINITY;
    expect(atTenKilobytes).toBeGreaterThan(0);
    expect(
      atTwoHundredKilobytes,
      `mounted elements by reply size: ${JSON.stringify([...elementCounts])}`,
    ).toBeLessThanOrEqual(2 * atTenKilobytes);
  });

  it("keeps every block a selection runs across drawn while the reader scrolls away", async () => {
    const { scroller, windowedBody } = await mountBodies(longReplyMarkdown(24_000), {
      isComplete: true,
      drawsFlowBody: false,
    });
    const selected = drawnBlocks(windowedBody);
    const startBlock = selected.get(1);
    const endBlock = selected.get(3);
    if (startBlock === undefined || endBlock === undefined) {
      throw new Error("the reply's first blocks were not drawn at the top");
    }
    const selection = document.getSelection();
    selection?.setBaseAndExtent(textEnds(startBlock).first, 2, textEnds(endBlock).last, 3);
    await settleFrames();
    const selectedText = selection?.toString() ?? "";

    await scrollToEnd(scroller);

    const drawnAfterScroll = drawnBlocks(windowedBody);
    expect([1, 2, 3].map((index) => drawnAfterScroll.has(index))).toStrictEqual([true, true, true]);
    expect(selection?.toString()).toBe(selectedText);
    selection?.removeAllRanges();
  });

  it("copies a selection across the whole windowed reply as the whole reply copies", async () => {
    const { scroller, windowedBody, flowBody } = await mountBodies(longReplyMarkdown(16_000), {
      isComplete: true,
      drawsFlowBody: true,
    });
    if (flowBody === undefined) {
      throw new Error("the whole reply did not mount");
    }
    const selection = document.getSelection();
    const firstBlock = drawnBlocks(windowedBody).get(0);
    if (firstBlock === undefined || selection === null) {
      throw new Error("the reply's first block was not drawn at the top");
    }
    // The reader starts at the top, scrolls to the end and extends the selection there.
    selection.collapse(textEnds(firstBlock).first, 0);
    selection.extend(textEnds(firstBlock).last, 1);
    await settleFrames();
    await scrollToEnd(scroller);
    const lastIndex = Math.max(...drawnBlocks(windowedBody).keys());
    const lastBlock = drawnBlocks(windowedBody).get(lastIndex);
    if (lastBlock === undefined) {
      throw new Error("the reply's last block was not drawn at the end");
    }
    const lastText = textEnds(lastBlock).last;
    selection.extend(lastText, lastText.length);
    await settleFrames();
    const windowedCopy = drawnTreeText(
      fromDom(selection.getRangeAt(0).cloneContents()),
      "markdown",
    );

    const flowEnds = textEnds(flowBody);
    const flowRange = document.createRange();
    flowRange.setStart(flowEnds.first, 0);
    flowRange.setEnd(flowEnds.last, flowEnds.last.length);
    selection.removeAllRanges();

    expect(windowedCopy).toBe(drawnTreeText(fromDom(flowRange.cloneContents()), "markdown"));
    const drawnAtEnd = drawnBlocks(windowedBody);
    expect(drawnAtEnd.size).toBe(lastIndex + 1);
    expect(
      [...drawnAtEnd.values()].reduce((count, wrapper) => count + wrapper.children.length, 0),
    ).toBe(flowBody.children.length);
  });

  it("keeps the block a reader reads in place when the reply's text size changes", async () => {
    const { scroller, windowedBody } = await mountBodies(coldReplyMarkdown(), {
      isComplete: true,
      drawsFlowBody: false,
    });
    await scrollTo(scroller, scroller.scrollHeight / 2);
    // The first block starting on screen is brought to the reader's top, so the block before it
    // ends just above the reader.
    const scrollerTopPx = scroller.getBoundingClientRect().top;
    const [index, block] =
      [...drawnBlocks(windowedBody).entries()]
        .sort(([left], [right]) => left - right)
        .find(([, wrapper]) => wrapper.getBoundingClientRect().top > scrollerTopPx) ??
      expect.fail("no block starts on the scroller's screen");
    await scrollTo(
      scroller,
      scroller.scrollTop + block.getBoundingClientRect().top - scrollerTopPx,
    );
    const readBlockTopPx = (): number =>
      (
        drawnBlocks(windowedBody).get(index) ?? expect.fail(`block ${String(index)} is not drawn`)
      ).getBoundingClientRect().top;
    const readerTopPx = readBlockTopPx();
    const scrollTopPx = scroller.scrollTop;

    // A larger text size: every block wraps anew, the ones above the reader included.
    windowedBody.style.fontSize = "17px";
    await settleFrames();

    expect(Math.abs(readBlockTopPx() - readerTopPx)).toBeLessThanOrEqual(
      SAME_LINE_TOLERANCE_PX + 0.5,
    );
    // The control: the blocks above the reader grew, and the scroller moved by what they changed.
    expect(scroller.scrollTop - scrollTopPx).toBeGreaterThan(SCROLLER_HEIGHT_PX);
  });

  it("keeps the text being read still while blocks above it draw for the first time", async () => {
    // The reply's row spans the box, so the conversation holds nothing for it: a block drawn above
    // the reader at another height than its estimate would move every line below it.
    const { scroller, windowedBody } = await mountBodies(coldReplyMarkdown(), {
      isComplete: true,
      drawsFlowBody: false,
    });
    await scrollToEnd(scroller);
    let heldPx = 0;
    for (let step = 0; step < READ_UP_STEPS; step += 1) {
      const readAtPx = scroller.scrollTop - SCROLLER_HEIGHT_PX / 2;
      scroller.scrollTop = readAtPx;
      const block = blockAtMiddleOf(scroller, windowedBody);
      const topPx = block.getBoundingClientRect().top;
      await settleFrames();
      expect(
        Math.abs(block.getBoundingClientRect().top - topPx),
        `step ${String(step)}`,
      ).toBeLessThanOrEqual(SAME_LINE_TOLERANCE_PX + 0.5);
      heldPx += scroller.scrollTop - readAtPx;
    }
    // The control: blocks above the reader did draw at other heights than estimated, and the
    // scroller moved by what they changed.
    expect(Math.abs(heldPx)).toBeGreaterThan(SAME_LINE_TOLERANCE_PX);
  });

  it("draws a far jump's blocks from their trees on the frame they mount, after a collection too", async () => {
    // No footnote definition, which draws nothing where it stands, so every drawn block holds an
    // element.
    const { scroller, windowedBody } = await mountBodies(longReplyMarkdown(200_000), {
      isComplete: true,
      drawsFlowBody: false,
    });
    const firstDrawn = new Set(drawnBlocks(windowedBody).keys());
    const lastIndex = Math.max(...firstDrawn);

    // Jumps far past the drawn band, as a scrollbar drag makes, each after a collection, so the
    // blocks drawn again at the top read their trees anew; every frame is checked as it paints.
    for (const share of [0.5, 0.9, 0.25, 0]) {
      collectGarbage();
      scroller.scrollTop = Math.round(scroller.scrollHeight * share);
      for (let frame = 0; frame < 4; frame += 1) {
        await letFramePaint();
        expect(
          blocksDrawnEmpty(windowedBody),
          `frame ${String(frame)} at ${String(share)}`,
        ).toEqual([]);
      }
      // The control: past the first screen, the window drew blocks the first frame had not.
      const drawn = [...drawnBlocks(windowedBody).keys()];
      expect(drawn.length).toBeGreaterThan(0);
      if (share > 0) {
        expect(Math.min(...drawn)).toBeGreaterThan(lastIndex);
      }
    }
  });

  it("draws every block and the tail formatted on their first frame while the parser answers late", async () => {
    const parse = markdownWorker.parse.bind(markdownWorker);
    const lateParse = vi
      .spyOn(markdownWorker, "parse")
      .mockImplementation((source, settle: (answer: MarkdownParseAnswer) => void) => {
        parse(source, (answer) => {
          setTimeout(() => {
            settle(answer);
          }, LATE_ANSWER_MS);
        });
      });
    try {
      // Still streaming, so its first draw holds settled blocks and a tail. A footnote defined in
      // a settled block and one defined in the tail make every block wait on both reads.
      const reply = [
        "It opens on a note[^1].",
        "[^1]: The note's text.",
        longReplyMarkdown(24_000),
        "It closes on another[^2].",
        "[^2]: The other note's text.",
      ].join("\n\n");
      const { scroller, windowedBody, flowBody, handle } = await mountBodies(reply, {
        isComplete: false,
        drawsFlowBody: true,
      });
      if (flowBody === undefined) {
        throw new Error("the whole reply did not mount");
      }
      const blockCount = flowBody.children.length;
      expect(drawnBlocks(windowedBody).size).toBeGreaterThan(0);

      // Other replies' trees fill the shared cache past its cap, so none of these blocks is kept
      // there when the window draws it again.
      await fillTreeCache("Evicting");

      // A jump to the middle, a fling to the end, back to the top and down to the tail again, each
      // a frame apart: every block and the tail the window draws again is drawn from its tree on
      // the frame it mounts.
      const middle = Math.round(scroller.scrollHeight / 2);
      const end = scroller.scrollHeight;
      for (const scrollTop of [middle, middle + 2_400, middle + 4_800, end, 0, end]) {
        scroller.scrollTop = scrollTop;
        await letFramePaint();
        await letFramePaint();
        expect(drawnBlocks(windowedBody).size, `drawn at ${String(scrollTop)}`).toBeGreaterThan(0);
      }
      await settleFrames();
      expect(flowBody.children.length).toBe(blockCount);

      // The reply is replaced from an early block on: what it drew stays until the new trees land.
      const { setText } = handle;
      const rewrittenReply = reply.replace("Section 1 ", "Rewritten section 1 ");
      act(() => {
        setText?.(rewrittenReply);
      });
      for (let frame = 0; frame < 8; frame += 1) {
        await letFramePaint();
        expect(flowBody.textContent, `frame ${String(frame)} after the replacement`).not.toBe("");
        expect(drawnBlocks(windowedBody).size).toBeGreaterThan(0);
      }
      await settleFrames();
      expect(flowBody.textContent).toContain("Rewritten section 1");

      // The same reply mounted again while the first copy holds its trees, as a row drawn again
      // as it scrolls back in, draws every block and the tail on its first frame, though other
      // replies' trees passed through the cache since.
      await fillTreeCache("Passing");
      const frames = recordFrames(() => {
        const emptyBody = document.querySelector(".meridian-markdown:empty");
        return emptyBody === null ? unformattedDraw() : "an empty body";
      });
      const again = await mountBodies(rewrittenReply, { isComplete: false, drawsFlowBody: true });
      expect(frames.stop()).toEqual([]);
      expect(again.flowBody?.children.length).toBe(flowBody.children.length);
    } finally {
      lateParse.mockRestore();
    }
  });
});
