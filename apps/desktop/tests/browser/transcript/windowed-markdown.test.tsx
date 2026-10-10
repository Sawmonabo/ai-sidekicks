// A long reply drawn as a window over its blocks, against the same reply drawn whole, in the
// engine that lays them out. The claims are about where text lands, how many elements stay
// mounted and what a selection keeps, none of which a DOM shim can answer.

import { act } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { liveBridgeWrapper } from "../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../helpers/app/harness.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { rebuildMarkdown } from "#renderer/features/transcript/copy/clipboard-flavors.js";
import { StreamingMarkdown } from "#renderer/features/transcript/rows/bodies/StreamingMarkdown.js";
import {
  longReplyMarkdown,
  suiteWindowViewport,
} from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { TranscriptBodyViewportContext } from "#renderer/components/TranscriptBodyViewport/context.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import { ViewportSelectionTracker } from "#renderer/features/transcript/viewport/selection/tracker.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { publishedTextOf } from "#renderer/features/transcript/reveal/published-text.js";

/** The scroller's box, and the narrower column both bodies are laid out in. */
const SCROLLER_WIDTH_PX = 680;
const SCROLLER_HEIGHT_PX = 600;
const BODY_WIDTH_PX = 600;

/** How far apart two renderings of one line may land and still be the same pixel. */
const SAME_LINE_TOLERANCE_PX = 0.5;

/** Lets the window hear the scroll, re-render, mount and measure its blocks, and paint. */
async function settleFrames(): Promise<void> {
  for (let frame = 0; frame < 4; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  }
}

/** Where a case reaches into the mounted bodies. */
interface BodiesHandle {
  setText?: (text: string) => void;
}

interface MountedBodies {
  readonly scroller: HTMLElement;
  readonly windowedBody: HTMLElement;
  /** The same reply drawn whole, outside the scroller; absent when the case draws none. */
  readonly flowBody: HTMLElement | undefined;
  readonly handle: BodiesHandle;
}

/**
 * Mounts a reply windowed inside a scroller, as the transcript draws it, and optionally the same
 * reply drawn whole beside it at the same width.
 */
async function mountBodies(
  initialText: string,
  options: { readonly isComplete: boolean; readonly drawsFlowBody: boolean },
): Promise<MountedBodies> {
  installMeridianTokens(document);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const tracker = new ViewportSelectionTracker();
  const viewport = suiteWindowViewport(scrollController, {
    subscribe: (listener) => tracker.subscribe(listener),
    read: () => tracker.selectionRange,
  });
  const handle: BodiesHandle = {};
  const Wrapper = liveBridgeWrapper();

  function Bodies(): React.JSX.Element {
    const [text, setText] = useState(initialText);
    handle.setText = setText;
    return (
      <Wrapper>
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          <div
            data-testid="scroller"
            ref={(element) => {
              if (element === null) {
                tracker.detach();
                scrollController.detach();
                return;
              }
              scrollController.attach(element);
              tracker.attach(element);
            }}
            style={{
              width: `${String(SCROLLER_WIDTH_PX)}px`,
              height: `${String(SCROLLER_HEIGHT_PX)}px`,
              overflowY: "scroll",
            }}
          >
            <div
              {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: 0 }}
              style={{ width: `${String(BODY_WIDTH_PX)}px` }}
            >
              <TranscriptBodyViewportContext value={viewport}>
                <StreamingMarkdown
                  publishedText={publishedTextOf(text)}
                  sourceId="reply"
                  footnotes={new FootnoteRegistry()}
                  isComplete={options.isComplete}
                  offersCodeCopy
                />
              </TranscriptBodyViewportContext>
            </div>
          </div>
          {options.drawsFlowBody ? (
            <div data-testid="flow" style={{ width: `${String(BODY_WIDTH_PX)}px` }}>
              <StreamingMarkdown
                publishedText={publishedTextOf(text)}
                sourceId="reply-whole"
                footnotes={new FootnoteRegistry()}
                isComplete={options.isComplete}
                offersCodeCopy
              />
            </div>
          ) : null}
        </div>
      </Wrapper>
    );
  }

  const { container } = await renderSettled(<Bodies />);
  await settleFrames();
  const scroller = container.querySelector<HTMLElement>("[data-testid='scroller']");
  const windowedBody = scroller?.querySelector<HTMLElement>(".meridian-markdown");
  const flowBody =
    container.querySelector<HTMLElement>("[data-testid='flow'] .meridian-markdown") ?? undefined;
  if (scroller === null || windowedBody === null || windowedBody === undefined) {
    throw new Error("the windowed body did not mount");
  }
  return { scroller, windowedBody, flowBody, handle };
}

/** The windowed body's drawn block wrappers, by index. */
function drawnBlocks(windowedBody: HTMLElement): Map<number, HTMLElement> {
  const blocks = new Map<number, HTMLElement>();
  for (const wrapper of windowedBody.querySelectorAll<HTMLElement>(
    `[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}]`,
  )) {
    blocks.set(Number(wrapper.getAttribute(MARKDOWN_BLOCK_INDEX_ATTRIBUTE)), wrapper);
  }
  return blocks;
}

/** An element's first line, as its top below the body's top. */
function firstLineOffsetPx(element: Element | null | undefined, body: HTMLElement): number {
  if (element === null || element === undefined) {
    throw new Error("the whole reply drew no element there");
  }
  return element.getBoundingClientRect().top - body.getBoundingClientRect().top;
}

async function scrollTo(scroller: HTMLElement, scrollTop: number): Promise<void> {
  scroller.scrollTop = scrollTop;
  await settleFrames();
}

/** Scrolls to the end, and again while the blocks measured there move it. */
async function scrollToEnd(scroller: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const scrollHeight = scroller.scrollHeight;
    await scrollTo(scroller, scrollHeight);
    if (scroller.scrollHeight === scrollHeight) {
      return;
    }
  }
  throw new Error("the reply's end kept moving");
}

/** The first and last text nodes inside an element, in document order. */
function textEnds(element: Element): { readonly first: Text; readonly last: Text } {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let first: Text | undefined;
  let last: Text | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.trim() !== "") {
      first ??= node as Text;
      last = node as Text;
    }
  }
  if (first === undefined || last === undefined) {
    throw new Error("the element holds no text");
  }
  return { first, last };
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
    const windowedCopy = rebuildMarkdown(selection.getRangeAt(0).cloneContents());

    const flowEnds = textEnds(flowBody);
    const flowRange = document.createRange();
    flowRange.setStart(flowEnds.first, 0);
    flowRange.setEnd(flowEnds.last, flowEnds.last.length);
    selection.removeAllRanges();

    expect(windowedCopy).toBe(rebuildMarkdown(flowRange.cloneContents()));
    const drawnAtEnd = drawnBlocks(windowedBody);
    expect(drawnAtEnd.size).toBe(lastIndex + 1);
    expect(
      [...drawnAtEnd.values()].reduce((count, wrapper) => count + wrapper.children.length, 0),
    ).toBe(flowBody.children.length);
  });
});
