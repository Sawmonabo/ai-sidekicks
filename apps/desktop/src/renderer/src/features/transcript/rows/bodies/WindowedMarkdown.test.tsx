// A long body drawn as a window over its blocks: which blocks it parses, and what a drawn block
// still resolves once the block defining its footnote is no longer drawn.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as markdownParse from "#renderer/components/Markdown/parse.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { TranscriptBodyViewportContext } from "#renderer/components/TranscriptBodyViewport/context.js";
import { MARKDOWN_BLOCK_INDEX_ATTRIBUTE } from "../markdown/block-window/markers.js";
import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { MarkdownBlockSegmenter } from "../markdown/parse/block-segmenter.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { longReplyMarkdown, suiteWindowViewport } from "./WindowedMarkdown.test-support.js";
import { publishedTextOf } from "../../reveal/published-text.js";

vi.mock("#renderer/components/Markdown/parse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof markdownParse>();
  return {
    ...actual,
    parseMarkdown: vi.fn(actual.parseMarkdown),
    parseSettledBlock: vi.fn(actual.parseSettledBlock),
  };
});

const settledBlockParses = vi.mocked(markdownParse.parseSettledBlock);
const wholeParses = vi.mocked(markdownParse.parseMarkdown);

const SCROLLER_HEIGHT_PX = 600;

/** A windowed body mounted in a scroller, and the way a case scrolls it. */
interface MountedWindow {
  readonly body: HTMLElement;
  readonly scrollTo: (scrollTop: number) => void;
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
    <TranscriptBodyViewportContext value={viewport}>
      <StreamingMarkdown
        publishedText={publishedTextOf(text)}
        sourceId="reply"
        footnotes={footnotes}
        isComplete
        offersCodeCopy
      />
    </TranscriptBodyViewportContext>,
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
    scrollTo: (nextScrollTop) => {
      act(() => {
        scrollTop = nextScrollTop;
        scroller.dispatchEvent(new Event("scroll"));
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
  it("parses only the blocks it draws, and none as they settle", () => {
    const text = longReplyMarkdown(40_000);
    const blockSources = new MarkdownBlockSegmenter()
      .segment(publishedTextOf(text), { isFinal: true })
      .settledBlocks.map(({ start, end }) => text.slice(start, end));
    settledBlockParses.mockClear();
    wholeParses.mockClear();

    const { body } = mountWindow(text, new FootnoteRegistry());

    const drawnSources = drawnIndexes(body).map((index) => blockSources[index]);
    expect(drawnSources.length).toBeGreaterThan(0);
    expect(drawnSources.length).toBeLessThan(blockSources.length / 4);
    expect(new Set(settledBlockParses.mock.calls.map(([source]) => source))).toStrictEqual(
      new Set(drawnSources),
    );
    expect(wholeParses).not.toHaveBeenCalled();
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
