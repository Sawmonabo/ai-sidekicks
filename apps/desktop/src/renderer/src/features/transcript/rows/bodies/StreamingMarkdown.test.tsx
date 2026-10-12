import { act, render, screen, type RenderResult } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appMarkdownTrees,
  footnoteDefinitionPreamble,
} from "#renderer/components/Markdown/parse/trees.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { appMarkdownWorkers } from "#test/helpers/markdown-worker.js";
import { duplicateKeyReports, reportsWhileReactRan } from "#test/helpers/react-reports.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { publishedTextOf } from "../../reveal/published-text.js";

/** A markdown body drawn inside a window, which supplies its code colors. */
function renderInWindow(body: React.JSX.Element): RenderResult {
  return render(body, { wrapper: liveBridgeWrapper() });
}

/** A body whose first two blocks repeat, with two more behind them so both settle. */
const REPEATED_BLOCKS_SETTLED = "same\n\nsame\n\nc\n\nd\n\ne\n\nf";

/** A different history entirely — what a rebase hands the segmenter. */
const REBASED_BLOCKS = "other\n\nwords\n\nx\n\ny\n\nz\n\nw";

const PARAGRAPH_SELECTOR = ".meridian-markdown__paragraph";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a streaming body", () => {
  it("renders what has arrived so far", () => {
    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf("the first sentence")}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
      />,
    );
    expect(container.textContent).toContain("the first sentence");
  });

  it("gives two identical settled blocks two identities", async () => {
    // React reports a duplicate key on `console.error`; keying by text alone fails here when a
    // message repeats a line.
    const {
      value: { container },
      reported,
    } = await reportsWhileReactRan(() =>
      renderInWindow(
        <StreamingMarkdown
          publishedText={publishedTextOf(REPEATED_BLOCKS_SETTLED)}
          sourceId="event-11"
          footnotes={new FootnoteRegistry()}
          isComplete={false}
          offersBlockCopy={false}
        />,
      ),
    );

    expect(duplicateKeyReports(reported)).toStrictEqual([]);
    const repeated = [...container.querySelectorAll(PARAGRAPH_SELECTOR)].filter(
      (paragraph) => paragraph.textContent === "same",
    );
    expect(repeated).toHaveLength(2);
  });

  it("keeps a settled block's element as later blocks settle behind it", () => {
    // The last line is unterminated and two blocks lag behind it, so only the first two settle.
    const { container, rerender } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf("first\n\nsecond\n\nthird\n\nfourth\n\nfifth")}
        sourceId="event-12"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
      />,
    );
    const firstSettled = container.querySelector(PARAGRAPH_SELECTOR);
    expect(firstSettled?.textContent).toBe("first");

    rerender(
      <StreamingMarkdown
        publishedText={publishedTextOf(
          "first\n\nsecond\n\nthird\n\nfourth\n\nfifth\n\nsixth\n\nseventh",
        )}
        sourceId="event-12"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
      />,
    );

    expect(container.querySelector(PARAGRAPH_SELECTOR)).toBe(firstSettled);
  });

  it("a rebase remounts rather than reusing the old message's element", () => {
    // Position alone would make every key unique; the text's fingerprint in the key remounts.
    const footnotes = new FootnoteRegistry();
    const { container, rerender } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(REPEATED_BLOCKS_SETTLED)}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
        offersBlockCopy={false}
      />,
    );
    const firstSettled = container.querySelector(PARAGRAPH_SELECTOR);

    rerender(
      <StreamingMarkdown
        publishedText={publishedTextOf(REBASED_BLOCKS)}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
        offersBlockCopy={false}
      />,
    );

    const rebasedFirst = container.querySelector(PARAGRAPH_SELECTOR);
    expect(rebasedFirst?.textContent).toBe("other");
    expect(rebasedFirst).not.toBe(firstSettled);
  });
});

/** A reply streamed in frames, each a longer text: a block settles, then the tail grows. */
const STREAMED_FRAMES = [
  "alpha *one*\n\nbeta *two*\n\ngamma *three*\n\ndelta",
  "alpha *one*\n\nbeta *two*\n\ngamma *three*\n\ndelta *four*\n\nepsilon",
  "alpha *one*\n\nbeta *two*\n\ngamma *three*\n\ndelta *four*\n\nepsilon *five*",
] as const;

/** Each block's words, which every frame draws exactly once or not yet. */
const STREAMED_WORDS = ["alpha one", "beta two", "gamma three", "delta four", "epsilon five"];

/** The settled block's text, which the body waits on before drawing it alone. */
const SETTLING_BLOCK = "alpha *one*\n\n";

/**
 * What a frame drew: the empty boxes held for blocks with no tree, how many characters, and how
 * many times each block's words stand in the drawn text.
 */
function readDrawnFrame(container: HTMLElement): {
  readonly emptyBoxCount: number;
  readonly characterCount: number;
  readonly wordCounts: readonly number[];
} {
  const text = (container.textContent ?? "").replaceAll(/\s+/gu, " ");
  return {
    emptyBoxCount: container.querySelectorAll('div[aria-hidden="true"]:empty').length,
    characterCount: text.length,
    wordCounts: STREAMED_WORDS.map((words) => text.split(words).length - 1),
  };
}

describe("a streaming body whose parses are still out", () => {
  it("moves settling and finished blocks out of the tail in one step, never blank or twice", () => {
    const streamed = (frame: number, isComplete: boolean): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={publishedTextOf(STREAMED_FRAMES[frame] ?? "")}
        sourceId="event-40"
        footnotes={new FootnoteRegistry()}
        isComplete={isComplete}
        offersBlockCopy={false}
      />
    );
    const { container, rerender } = renderInWindow(streamed(0, false));
    const drawnFrames = [readDrawnFrame(container)];
    const worker = appMarkdownWorkers.latest();
    const answer = (isReleased: (request: { readonly source: string }) => boolean): void => {
      act(() => {
        worker.releaseWhere(isReleased);
      });
      drawnFrames.push(readDrawnFrame(container));
    };

    // A block settles and the tail grows twice while every parse is held.
    worker.hold();
    rerender(streamed(1, false));
    drawnFrames.push(readDrawnFrame(container));
    rerender(streamed(2, false));
    drawnFrames.push(readDrawnFrame(container));
    // Both tails land at the first growth, and each asks for the second.
    answer((request) => request.source !== SETTLING_BLOCK && !request.source.includes("five"));
    // The block and the drawn tail's second growth land; the shorter tail still stands a growth
    // behind, so the block stays inside the drawn tail.
    answer((request) => request.source.startsWith("alpha"));
    expect(drawnFrames.at(-1)?.wordCounts).toStrictEqual([1, 1, 1, 1, 1]);
    answer(() => true);
    // The body finishes while its last blocks' parses are held.
    rerender(streamed(2, true));
    drawnFrames.push(readDrawnFrame(container));
    answer(() => true);
    worker.release([]);

    for (const [index, frame] of drawnFrames.entries()) {
      expect(frame.emptyBoxCount).toBe(0);
      expect(frame.wordCounts.every((count) => count <= 1)).toBe(true);
      expect(frame.characterCount).toBeGreaterThanOrEqual(
        drawnFrames[index - 1]?.characterCount ?? 0,
      );
    }
    expect(drawnFrames.at(-1)?.wordCounts).toStrictEqual([1, 1, 1, 1, 1]);
    expect(container.querySelectorAll("em")).toHaveLength(5);
    expect(appMarkdownTrees.readSettledBlock("epsilon *five*", "")).toBeDefined();
  });
});

/**
 * A body whose settled blocks define and cite a footnote, ending on prose; then a second definition
 * settles while the prose grows.
 */
const FOOTNOTED_FRAMES = [
  "[^1]: the note\n\ncite[^1] here\n\nfiller one\n\nfiller two\n\nthe tail grows",
  "[^1]: the note\n\ncite[^1] here\n\nfiller one\n\nfiller two\n\nthe tail grows\n\n" +
    "[^2]: another note\n\nfiller three\n\nfiller four\n\nfiller five\n\nthe end grows",
  "[^1]: the note\n\ncite[^1] here\n\nfiller one\n\nfiller two\n\nthe tail grows\n\n" +
    "[^2]: another note\n\nfiller three\n\nfiller four\n\nfiller five\n\nthe end grows on",
] as const;

/**
 * The second definition's block: its tree, and its read alone for its footnotes, are the parses a
 * case holds, so the block stays inside the drawn tail.
 */
const SECOND_DEFINITION = /\[\^2\]: another note\s*$/u;

describe("a streaming body still reading a block for its footnotes", () => {
  it("keeps growing its tail", () => {
    markdownWorker.wake();
    const worker = appMarkdownWorkers.latest();
    worker.hold();
    const footnoted = (frame: number): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={publishedTextOf(FOOTNOTED_FRAMES[frame] ?? "")}
        sourceId="event-41"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
      />
    );
    // Each parse that lands may ask for the next, against the definitions it found.
    const answerAllBut = (isHeld: (request: { readonly source: string }) => boolean): void => {
      for (let round = 0; round < 4; round += 1) {
        act(() => {
          worker.releaseWhere((request) => !isHeld(request));
        });
      }
    };
    const { container, rerender } = renderInWindow(footnoted(0));
    answerAllBut(() => false);
    expect(container.textContent).toContain("the tail grows");

    // The second definition's parses stay out while the tail grows past it.
    const isSecondDefinition = (request: { readonly source: string }): boolean =>
      SECOND_DEFINITION.test(request.source);
    rerender(footnoted(1));
    answerAllBut(isSecondDefinition);
    rerender(footnoted(2));
    answerAllBut(isSecondDefinition);

    expect(container.textContent).toContain("the end grows on");
    act(() => {
      worker.releaseWhere(() => true);
    });
    worker.release([]);
  });
});

/** A construct whose author never closed it — bold that opens and simply stops. */
const UNCLOSED_EMPHASIS = "a settled paragraph\n\nthis is **bold";

describe("a body the sender has finished", () => {
  it("keeps every block settled, so nothing complete is rewritten by the mender", () => {
    // `remend` is for a prefix; on a finished body it would close emphasis the author left open.
    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(UNCLOSED_EMPHASIS)}
        sourceId="event-33"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersBlockCopy={false}
      />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**bold");
  });
});

/**
 * A citation far enough ahead of its definition that the citing block settles first (the
 * settle lag is two blocks).
 */
const CROSS_BLOCK_FOOTNOTE =
  "cite[^1] here\n\nfiller one\n\nfiller two\n\nfiller three\n\n[^1]: the note body\n";

// A definition is the one construct whose meaning depends on another block: the streaming
// pipeline hands the parser the committed prefix and the volatile tail as two documents.
describe("a footnote whose definition settles in another block", () => {
  it("is a real reference marker", () => {
    renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(CROSS_BLOCK_FOOTNOTE)}
        sourceId="event-30"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersBlockCopy={false}
      />,
    );

    // Parsed block by block, `[^1]` would be literal text; the body's definitions are
    // restated ahead of each block so the marker exists.
    const marker = screen.getByLabelText("Footnote 1");
    expect(marker.getAttribute("data-defined")).toBe("true");
  });

  it("parses each settled block once, against the definitions its streaming tail holds", () => {
    const asked = (): string[] =>
      appMarkdownWorkers.started.flatMap((worker) =>
        worker.requests.map((request) => request.source),
      );
    const askedBefore = asked().length;
    renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(
          "first filler\n\nsecond filler\n\nthird filler\n\nIt cites a note[^1].\n\n[^1]: the note",
        )}
        sourceId="event-31"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
      />,
    );

    // The tail is read alone for its definitions and drawn against them; the settled block is
    // asked for once, against them too.
    const blockAsks = asked()
      .slice(askedBefore)
      .filter((source) => !source.endsWith("[^1]: the note"));
    expect(blockAsks).toEqual([`${footnoteDefinitionPreamble(new Set(["1"]))}first filler\n\n`]);
    expect(screen.getByLabelText("Footnote 1").getAttribute("data-defined")).toBe("true");
  });
});

describe("a body whose trees another body holds", () => {
  it("draws every block and the tail in the commit it mounts", () => {
    // What a layout effect of an element around the body reads in the body's first commit, as
    // the transcript restores a selection in a row as it mounts.
    let firstCommitText: string | undefined;
    function FirstCommitProbe(props: { readonly children: React.ReactNode }): React.JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        firstCommitText ??= ref.current?.textContent;
      }, []);
      return <div ref={ref}>{props.children}</div>;
    }
    const body = (sourceId: string): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={publishedTextOf(`held ${CROSS_BLOCK_FOOTNOTE}`)}
        sourceId={sourceId}
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
      />
    );
    renderInWindow(body("event-42"));

    const { container } = renderInWindow(<FirstCommitProbe>{body("event-43")}</FirstCommitProbe>);
    expect(firstCommitText).toContain("filler three");
    expect(firstCommitText).toBe(container.textContent);
  });
});
