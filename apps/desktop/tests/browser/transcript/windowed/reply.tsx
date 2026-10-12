// A reply drawn in a scroller as the transcript draws it, inside a viewport, and the same reply
// drawn whole beside it, for the suites that compare the two in the engine that lays them out: the
// body's window over its blocks and a long table's window over its rows.

import { act, render } from "@testing-library/react";
import { useState } from "react";
import { onTestFinished, vi } from "vitest";

import { liveBridgeWrapper } from "../../../helpers/app/frame-fixtures.js";
import { renderSettled } from "../../../helpers/app/harness.js";
import { crossMacrotaskBoundary } from "../../../helpers/macrotask-boundary.js";
import { PaintedFrameReader } from "../painted-frames.js";
import { FASTEST_FLICK_SPEED, touchFling } from "../touch-fling.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { appPageParser } from "#renderer/components/Markdown/parse/page-parser.js";
import { parseTree } from "#renderer/components/Markdown/parse/trees.test-support.js";
import { COPY_FLAVOR_ATTRIBUTE } from "#renderer/features/transcript/copy/conversation-selection.js";
import { publishedTextOf } from "#renderer/features/transcript/reveal/published-text.js";
import { StreamingMarkdown } from "#renderer/features/transcript/rows/bodies/StreamingMarkdown.js";
import {
  SuiteWindowViewportProvider,
  suiteWindowViewport,
} from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import {
  DrawnWindowSources,
  DrawnWindowSourcesContext,
} from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
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

/** How many rounds of trees landing and asking for more `settleFrames` waits through. */
const SETTLE_ROUND_CAP = 8;

/** The key the scroller's one row, the reply, is known to the selection tracker by. */
const REPLY_ROW_KEY = "reply";

/**
 * A block drawn before its tree: in the window, a block's wrapper holding nothing or an empty box,
 * beside the window's own spacers; in the whole reply, any empty box among the body's elements. A
 * wrapper that holds nothing and takes no room, as a footnote's definition draws in place, is no
 * blank.
 */
const BLANK_BLOCK_SELECTOR = [
  `[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}]:empty`,
  `[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}] > div[aria-hidden="true"]`,
  `[data-testid="flow"] .meridian-markdown > div[aria-hidden="true"]`,
].join(", ");

/** Markdown's own syntax in the replies' text, which a formatted block never shows. */
const UNFORMATTED_RUNS = ["**", "```", "| ---", "## ", "[^"] as const;

/**
 * What one painted frame shows that a block drawn before its tree would, in the page or a frame on
 * it: a blank box, or a body's text with markdown's syntax still in it. `undefined` for a frame
 * that shows neither.
 */
function unformattedDraw(): string | undefined {
  for (const drawn of drawnDocuments()) {
    const blank = [...drawn.querySelectorAll(BLANK_BLOCK_SELECTOR)].find(
      (element) => element.getBoundingClientRect().height > 0,
    );
    if (blank !== undefined) {
      return `a blank block: ${blank.outerHTML.slice(0, 160)}`;
    }
    for (const body of drawn.querySelectorAll(".meridian-markdown")) {
      const text = body.textContent;
      const run = UNFORMATTED_RUNS.find((syntax) => text.includes(syntax));
      if (run !== undefined) {
        return `unformatted text: ${JSON.stringify(run)} in ${JSON.stringify(text.slice(0, 160))}`;
      }
    }
  }
  return undefined;
}

/**
 * One frame painted: the window hears what changed, re-renders, mounts and measures its items.
 * Throws when the frame draws a block before its tree.
 */
export async function letFramePaint(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
  const unformatted = unformattedDraw();
  if (unformatted !== undefined) {
    throw new Error(`a frame drew a block before its tree: ${unformatted}`);
  }
}

/**
 * Lets frames paint until the page's parser is ready and every cut and tree the bodies ask the
 * worker for has landed and drawn, one that lands asking for the next included, failing on the
 * first frame that draws a block before its tree. The worker answers in the order it is asked,
 * so the answer to one more text means every text and cut asked before it has landed; a round in
 * which the bodies asked for none is the last.
 */
export async function settleFrames(): Promise<void> {
  // A case that already stands in for the parser keeps its own stand-in, which this one reuses.
  const wasStoodIn = vi.isMockFunction(markdownWorker.parse);
  const asks = vi.spyOn(markdownWorker, "parse");
  const cuts = vi.spyOn(markdownWorker, "cut");
  try {
    // The page's parser starts once the worker has loaded it, which no body may have asked for yet.
    markdownWorker.wake();
    while (appPageParser.state !== "ready") {
      if (appPageParser.state === "failed") {
        throw new Error("the page's markdown parser failed to start");
      }
      await letFramePaint();
    }
    for (let round = 0; round < SETTLE_ROUND_CAP; round += 1) {
      const asksBefore = asks.mock.calls.length + cuts.mock.calls.length;
      for (let frame = 0; frame < 4; frame += 1) {
        await letFramePaint();
      }
      await act(async () => {
        await parseTree("");
      });
      for (let frame = 0; frame < 4; frame += 1) {
        await letFramePaint();
      }
      if (asks.mock.calls.length + cuts.mock.calls.length === asksBefore + 1) {
        return;
      }
    }
    throw new Error(`the bodies still asked for trees after ${String(SETTLE_ROUND_CAP)} rounds`);
  } finally {
    cuts.mockRestore();
    if (!wasStoodIn) {
      asks.mockRestore();
    }
  }
}

/** The page's document and each frame's on it, where a case draws its bodies. */
function drawnDocuments(): Document[] {
  return [
    document,
    ...[...document.querySelectorAll("iframe")].flatMap((frame) =>
      frame.contentDocument === null ? [] : [frame.contentDocument],
    ),
  ];
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
  /** What the windowed body's windows draw from, held as the feed holds it for a copy. */
  readonly drawnSources: DrawnWindowSources;
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
  const drawnSources = new DrawnWindowSources();
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
                <SuiteWindowViewportProvider viewport={viewport}>
                  <DrawnWindowSourcesContext value={drawnSources}>
                    <StreamingMarkdown
                      publishedText={publishedTextOf(text)}
                      sourceId="reply"
                      footnotes={new FootnoteRegistry()}
                      isComplete={options.isComplete}
                      offersBlockCopy
                    />
                  </DrawnWindowSourcesContext>
                </SuiteWindowViewportProvider>
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
  return { scroller, windowedBody, flowBody, handle, drawnSources };
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
