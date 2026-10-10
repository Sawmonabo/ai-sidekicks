// A reply drawn in a scroller as the transcript draws it, inside a viewport, and the same reply
// drawn whole beside it, for the suites that compare the two in the engine that lays them out: the
// body's window over its blocks and a long table's window over its rows.

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { onTestFinished } from "vitest";

import { liveBridgeWrapper } from "../../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../../helpers/app/harness.js";
import { crossMacrotaskBoundary } from "../../../helpers/macrotask-boundary.js";
import { PaintedFrameReader } from "../painted-frames.js";
import { FASTEST_FLICK_SPEED, touchFling } from "../touch-fling.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { COPY_FLAVOR_ATTRIBUTE } from "#renderer/features/transcript/copy/conversation-selection.js";
import { publishedTextOf } from "#renderer/features/transcript/reveal/published-text.js";
import { StreamingMarkdown } from "#renderer/features/transcript/rows/bodies/StreamingMarkdown.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { MarkdownWindowViewportContext } from "#renderer/features/transcript/rows/markdown/block-window/context.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "#renderer/features/transcript/rows/markdown/block-window/markers.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import { ViewportSelectionTracker } from "#renderer/features/transcript/viewport/selection/tracker.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";

/** The scroller's box, and the narrower column both bodies are laid out in. */
const SCROLLER_WIDTH_PX = 680;
export const SCROLLER_HEIGHT_PX = 600;
const BODY_WIDTH_PX = 600;
/** A fling's travel before the hand lets go, in screens. */
const FLING_TRAVEL_SCREENS = 3;

/** The key the scroller's one row, the reply, is known to the selection tracker by. */
const REPLY_ROW_KEY = "reply";

/** Lets a window hear the scroll, re-render, mount and measure its items, and paint. */
export async function settleFrames(): Promise<void> {
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
export interface BodiesHandle {
  setText?: (text: string) => void;
}

/** The bodies a case mounted, and where it reaches into them. */
export interface MountedBodies {
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
export async function mountBodies(
  initialText: string,
  options: {
    readonly isComplete: boolean;
    readonly drawsFlowBody: boolean;
    /**
     * Draws both bodies in a window's own document, a frame holding the page's stylesheets and the
     * faces, as the app draws a window it opened on `about:blank`; the faces are installed there
     * alone, so they load in that document and no other.
     */
    readonly drawsInFrame?: boolean;
  },
): Promise<MountedBodies> {
  const ownerDocument = options.drawsInFrame === true ? openFrameDocument() : document;
  installMeridianTokens(ownerDocument);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const tracker = new ViewportSelectionTracker({
    holdSelectedRows: () => {},
    logPositionOf: (rowKey) => (rowKey === REPLY_ROW_KEY ? 0 : undefined),
    drawRow: () => {},
  });
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
              // As the transcript's scroller: the windows hold the reader's place, the browser not.
              overflowAnchor: "none",
            }}
          >
            <div
              {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: 0 }}
              ref={(element) => {
                if (element !== null) {
                  tracker.addRow(element, REPLY_ROW_KEY);
                }
              }}
              style={{ width: `${String(BODY_WIDTH_PX)}px` }}
            >
              <div {...{ [COPY_FLAVOR_ATTRIBUTE]: "markdown" }}>
                <MarkdownWindowViewportContext value={viewport}>
                  <StreamingMarkdown
                    publishedText={publishedTextOf(text)}
                    sourceId="reply"
                    footnotes={new FootnoteRegistry()}
                    isComplete={options.isComplete}
                    offersBlockCopy
                  />
                </MarkdownWindowViewportContext>
              </div>
            </div>
          </div>
          {options.drawsFlowBody ? (
            <div data-testid="flow" style={{ width: `${String(BODY_WIDTH_PX)}px` }}>
              <div {...{ [COPY_FLAVOR_ATTRIBUTE]: "markdown" }}>
                <StreamingMarkdown
                  publishedText={publishedTextOf(text)}
                  sourceId="reply-whole"
                  footnotes={new FootnoteRegistry()}
                  isComplete={options.isComplete}
                  offersBlockCopy
                />
              </div>
            </div>
          ) : null}
        </div>
      </Wrapper>
    );
  }

  const container =
    ownerDocument === document
      ? (await renderSettled(<Bodies />)).container
      : await renderInto(ownerDocument, <Bodies />);
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

/** A frame's document holding a copy of every stylesheet on the page, removed after the test. */
function openFrameDocument(): Document {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0;";
  document.body.append(frame);
  onTestFinished(() => {
    frame.remove();
  });
  const frameDocument = frame.contentDocument;
  if (frameDocument === null) {
    throw new Error("the frame has no document");
  }
  for (const sheet of document.head.querySelectorAll("style, link[rel='stylesheet']")) {
    frameDocument.head.append(frameDocument.importNode(sheet, true));
  }
  return frameDocument;
}

async function renderInto(ownerDocument: Document, element: React.JSX.Element): Promise<Element> {
  const container = ownerDocument.createElement("div");
  ownerDocument.body.append(container);
  await act(async () => {
    render(element, { container });
    await crossMacrotaskBoundary();
  });
  return container;
}

/** The windowed body's drawn block wrappers, by index. */
export function drawnBlocks(windowedBody: HTMLElement): Map<number, HTMLElement> {
  const blocks = new Map<number, HTMLElement>();
  for (const wrapper of windowedBody.querySelectorAll<HTMLElement>(
    `[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}]`,
  )) {
    blocks.set(Number(wrapper.getAttribute(MARKDOWN_BLOCK_INDEX_ATTRIBUTE)), wrapper);
  }
  return blocks;
}

export async function scrollTo(scroller: HTMLElement, scrollTop: number): Promise<void> {
  scroller.scrollTop = scrollTop;
  await settleFrames();
}

/**
 * Flings the scroller toward its end with the fastest touch flick, three screens of travel and its
 * momentum, and answers how much of the box showed of the elements `spacersOf` reads in each
 * frame as it is painted, for the frames that showed any, in pixels. `itemSelector` names the
 * window's drawn items, which a frame's read waits on as they resize.
 */
export async function flingShowingSpacers(
  scroller: HTMLElement,
  itemSelector: string,
  spacersOf: () => readonly Element[],
): Promise<number[]> {
  const shownPxByFrame: number[] = [];
  const frames = new PaintedFrameReader(
    itemSelector,
    () => {
      const box = scroller.getBoundingClientRect();
      let shownPx = 0;
      for (const spacer of spacersOf()) {
        const rect = spacer.getBoundingClientRect();
        shownPx += Math.max(0, Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top));
      }
      return shownPx;
    },
    (shownPx) => {
      if (shownPx > 0) {
        shownPxByFrame.push(shownPx);
      }
    },
  );
  try {
    await touchFling(scroller, -FLING_TRAVEL_SCREENS * SCROLLER_HEIGHT_PX, FASTEST_FLICK_SPEED);
  } finally {
    frames.stop();
  }
  return shownPxByFrame;
}

/** Scrolls to the end, and again while the blocks measured there move it. */
export async function scrollToEnd(scroller: HTMLElement): Promise<void> {
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
export function textEnds(element: Element): { readonly first: Text; readonly last: Text } {
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
