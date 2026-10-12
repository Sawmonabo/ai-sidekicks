// A long body drawn as a window over its blocks: its mounted blocks parsed on the page and let go
// as they leave, when a scroll's blocks are drawn, what a drawn block still resolves once the block
// defining its footnote is no longer drawn, and how it draws while the page's parser is not ready
// or could not start.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appPageParser, PageParser } from "#renderer/components/Markdown/parse/page-parser.js";
import { startPageParser } from "#renderer/components/Markdown/parse/page-parser.test-support.js";
import { loadMarkdownParserCalls } from "#renderer/components/Markdown/parse/parser-calls.js";
import { appMarkdownTrees, MarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { MarkdownWorkerConnection } from "#renderer/components/Markdown/worker/connection.js";
import {
  InThreadMarkdownWorkers,
  inThreadParserModule,
} from "#renderer/components/Markdown/worker/connection.test-support.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "../markdown/block-window/markers.js";
import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { type MarkdownBodyBlocks } from "../markdown/body-blocks/reader.js";
import { bodyBlocksForTest } from "../markdown/body-blocks/reader.test-support.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import {
  longReplyMarkdown,
  SuiteWindowViewportProvider,
  suiteWindowViewport,
} from "./WindowedMarkdown.test-support.js";
import { publishedTextOf } from "#renderer/lib/text/published.js";
import { appTextCompression } from "#renderer/lib/text/compression.js";

const pageParses = vi.spyOn(appMarkdownTrees, "parseSettledBlockNow");
const settledBlockHolds = vi.spyOn(appMarkdownTrees, "holdSettledBlock");
const settledBlockReads = vi.spyOn(appMarkdownTrees, "requestSettledBlock");
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
 * Mounts a finished reply inside a scroller the window reads, as the transcript draws it, read by
 * `bodyBlocks`. The scroller's height and offset are given, since this DOM lays nothing out.
 */
function mountWindow(
  text: string,
  footnotes: FootnoteRegistry,
  bodyBlocks: MarkdownBodyBlocks = bodyBlocksForTest(),
): MountedWindow {
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
        bodyBlocks={bodyBlocks}
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
  return {
    get body() {
      const body = container.querySelector<HTMLElement>(".meridian-markdown");
      if (body === null) {
        throw new Error("the body did not mount");
      }
      return body;
    },
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
  it("parses its mounted blocks on the page, asks the worker for none, and keeps none it let go", () => {
    const text = longReplyMarkdown(40_000);
    const blockCount = appPageParser.parse(text).children.length;
    pageParses.mockClear();
    settledBlockHolds.mockClear();
    settledBlockReads.mockClear();
    wholeParses.mockClear();

    const { body, scrollTo } = mountWindow(text, new FootnoteRegistry());
    const drawnAtTop = drawnIndexes(body);
    const parsedAtTop = pageParses.mock.calls.length;
    scrollTo(1_000_000);
    expect(drawnIndexes(body)).not.toContain(drawnAtTop[0]);
    scrollTo(0);

    expect(drawnAtTop.length).toBeGreaterThan(0);
    expect(drawnAtTop.length).toBeLessThan(blockCount / 4);
    expect(parsedAtTop).toBeGreaterThanOrEqual(drawnAtTop.length);
    // The blocks drawn again at the top were let go as they left, so each is parsed again.
    const firstSource = pageParses.mock.calls[0]?.[0] ?? expect.fail("a block parsed on the page");
    expect(pageParses.mock.calls.filter(([source]) => source === firstSource)).toHaveLength(2);
    expect(settledBlockHolds).not.toHaveBeenCalled();
    expect(settledBlockReads).not.toHaveBeenCalled();
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
    // The defining block was read on the page, never asked of the worker.
    expect(settledBlockReads).not.toHaveBeenCalled();
    expect(footnotes.definitionsFor("reply").get("1")?.bodyNodes).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: "the note body" }] },
    ]);
  });
});

describe("a long body whose page parser is not ready", () => {
  /** A body's own blocks, parsed by stand-in workers and `pageParser`. */
  function bodyBlocksOn(pageParser: PageParser): {
    readonly bodyBlocks: MarkdownBodyBlocks;
    readonly trees: MarkdownTrees;
  } {
    const workers = new InThreadMarkdownWorkers();
    const trees = new MarkdownTrees(
      new MarkdownWorkerConnection(workers.start, window, pageParser, appTextCompression),
    );
    return { bodyBlocks: bodyBlocksForTest(trees), trees };
  }

  it("draws formatted from the worker's trees once the page parser failed", () => {
    const pageParser = new PageParser(loadMarkdownParserCalls);
    pageParser.fail();
    const { bodyBlocks, trees } = bodyBlocksOn(pageParser);
    const workerHolds = vi.spyOn(trees, "holdSettledBlock");

    const { body } = mountWindow(longReplyMarkdown(40_000), new FootnoteRegistry(), bodyBlocks);

    expect(drawnIndexes(body).length).toBeGreaterThan(0);
    expect(body.querySelector("em")).not.toBeNull();
    expect(workerHolds).toHaveBeenCalled();
  });

  it("draws nothing until the page parser starts, then draws formatted asking the worker for no block", async () => {
    const pageParser = new PageParser(loadMarkdownParserCalls);
    const { bodyBlocks, trees } = bodyBlocksOn(pageParser);
    const workerHolds = vi.spyOn(trees, "holdSettledBlock");
    const workerReads = vi.spyOn(trees, "requestSettledBlock");

    const mounted = mountWindow(longReplyMarkdown(40_000), new FootnoteRegistry(), bodyBlocks);
    expect(pageParser.state).toBe("idle");
    expect(mounted.body.textContent).toBe("");

    await act(async () => {
      await startPageParser(pageParser, inThreadParserModule());
    });

    expect(drawnIndexes(mounted.body).length).toBeGreaterThan(0);
    expect(mounted.body.querySelector("em")).not.toBeNull();
    expect(workerHolds).not.toHaveBeenCalled();
    expect(workerReads).not.toHaveBeenCalled();
  });
});
