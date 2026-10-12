// A long body drawn as a window over its blocks: how often it asks for each block's tree, when a
// scroll's blocks are drawn, and what a drawn block still resolves once the block defining its
// footnote is no longer drawn.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "../markdown/block-window/markers.js";
import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { MarkdownBlockSegmenter } from "../markdown/parse/block-segmenter.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import {
  longReplyMarkdown,
  SuiteWindowViewportProvider,
  suiteWindowViewport,
} from "./WindowedMarkdown.test-support.js";
import { publishedTextOf } from "../../reveal/published-text.js";

const settledBlockParses = vi.spyOn(appMarkdownTrees, "holdSettledBlock");
const wholeParses = vi.spyOn(appMarkdownTrees, "requestTree");

const SCROLLER_HEIGHT_PX = 600;

/** A windowed body mounted in a scroller, and the way a case scrolls it. */
interface MountedWindow {
  readonly body: HTMLElement;
  /** Scrolls to `scrollTop`; `whileScrolling` reads the page right after the scroll event. */
  readonly scrollTo: (scrollTop: number, whileScrolling?: () => void) => void;
}

const teardowns: (() => void)[] = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

/**
 * Mounts a finished reply inside a scroller the window reads, as the transcript draws it. The
 * scroller's height and offset are given, since this DOM lays nothing out.
 */
function mountWindow(text: string, footnotes: FootnoteRegistry): MountedWindow {
  // happy-dom has no idle callback; one that never fires stands in, as on a page granting no idle.
  vi.stubGlobal("requestIdleCallback", () => 0);
  teardowns.push(() => {
    vi.unstubAllGlobals();
  });
  const scroller = document.createElement("div");
  let scrollTop = 0;
  Object.defineProperty(scroller, "clientHeight", { get: () => SCROLLER_HEIGHT_PX });
  Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop });
  document.body.append(scroller);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  scrollController.attach(scroller);
  const viewport = suiteWindowViewport(scrollController, {
    subscribe: () => () => undefined,
    read: () => undefined,
  });
  const { container, unmount } = render(
    <SuiteWindowViewportProvider viewport={viewport}>
      <StreamingMarkdown
        publishedText={publishedTextOf(text)}
        sourceId="reply"
        footnotes={footnotes}
        isComplete
        offersBlockCopy
      />
    </SuiteWindowViewportProvider>,
    {
      wrapper: liveBridgeWrapper(),
      container: scroller.appendChild(document.createElement("div")),
    },
  );
  teardowns.push(() => {
    unmount();
    scrollController.dispose();
    scroller.remove();
  });
  const body = container.querySelector<HTMLElement>(".meridian-markdown");
  if (body === null) {
    throw new Error("the body did not mount");
  }
  return {
    body,
    scrollTo: (nextScrollTop, whileScrolling) => {
      act(() => {
        scrollTop = nextScrollTop;
        scroller.dispatchEvent(new Event("scroll"));
        whileScrolling?.();
      });
    },
  };
}

/** The indexes of the blocks the window draws. */
function drawnIndexes(body: HTMLElement): number[] {
  return [...body.querySelectorAll(`[${MARKDOWN_BLOCK_INDEX_ATTRIBUTE}]`)].map((wrapper) =>
    Number(wrapper.getAttribute(MARKDOWN_BLOCK_INDEX_ATTRIBUTE)),
  );
}

describe("a long body drawn as a window over its blocks", () => {
  it("asks for each block's tree once, and none again as blocks scroll into the window", () => {
    const text = longReplyMarkdown(40_000);
    const blockSources = new MarkdownBlockSegmenter()
      .segment(publishedTextOf(text), { isFinal: true })
      .settledBlocks.map(({ start, end }) => text.slice(start, end));
    settledBlockParses.mockClear();
    wholeParses.mockClear();

    const { body, scrollTo } = mountWindow(text, new FootnoteRegistry());
    const drawnAtTop = drawnIndexes(body);
    scrollTo(1_000_000);

    expect(drawnAtTop.length).toBeGreaterThan(0);
    expect(drawnAtTop.length).toBeLessThan(blockSources.length / 4);
    expect(drawnIndexes(body)).not.toContain(drawnAtTop[0]);
    expect(settledBlockParses.mock.calls.map(([source]) => source).sort()).toStrictEqual(
      blockSources.sort(),
    );
    expect(wholeParses).not.toHaveBeenCalled();
  });

  it("draws the blocks a scroll brings into its band before the frame that scrolled paints", () => {
    const { body, scrollTo } = mountWindow(longReplyMarkdown(40_000), new FootnoteRegistry());
    expect(drawnIndexes(body)).toContain(0);

    let drawnAsScrolled: number[] = [];
    scrollTo(20_000, () => {
      drawnAsScrolled = drawnIndexes(body);
    });

    expect(drawnAsScrolled).not.toContain(0);
    expect(drawnAsScrolled).toStrictEqual(drawnIndexes(body));
  });

  it("resolves a reference and keeps the definition registered once the defining block is not drawn", () => {
    const text =
      "Opening cites a note[^1] here.\n\n[^1]: the note body\n\n" +
      `${longReplyMarkdown(40_000)}\n\nClosing cites the same note[^1] again.`;
    const footnotes = new FootnoteRegistry();
    const { body, scrollTo } = mountWindow(text, footnotes);
    expect(drawnIndexes(body)).toContain(1);

    scrollTo(1_000_000);

    expect(drawnIndexes(body)).not.toContain(1);
    expect(screen.getByLabelText("Footnote 1").getAttribute("data-defined")).toBe("true");
    expect(footnotes.definitionsFor("reply").get("1")?.bodyNodes).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: "the note body" }] },
    ]);
  });
});
