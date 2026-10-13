import { act, render, screen, type RenderResult } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { definitionPreambleOf } from "#renderer/components/Markdown/parse/definition-preamble.js";
import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { appMarkdownWorkers } from "#test/helpers/markdown-worker.js";
import { duplicateKeyReports, reportsWhileReactRan } from "#test/helpers/react-reports.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { windowedBlockKeyOf } from "../markdown/block-window/layout.js";
import { type MarkdownBodyBlocks } from "../markdown/body-blocks/reader.js";
import { bodyBlocksForTest } from "../markdown/body-blocks/reader.test-support.js";
import { type MarkdownBodyBlocksSnapshot } from "../markdown/body-blocks/snapshot.js";
import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { publishedTextOf, type PublishedText } from "#renderer/lib/text/published.js";

/** A markdown body drawn inside a window, which supplies its code colors. */
function renderInWindow(body: React.JSX.Element): RenderResult {
  return render(body, { wrapper: liveBridgeWrapper() });
}

/** A body whose first two blocks repeat, with two more behind them so both settle. */
const REPEATED_BLOCKS_SETTLED = "same\n\nsame\n\nc\n\nd\n\ne\n\nf";

/** A different history entirely — what a rebase hands the body. */
const REBASED_BLOCKS = "other\n\nwords\n\nx\n\ny\n\nz\n\nw";

const PARAGRAPH_SELECTOR = ".meridian-markdown__paragraph";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a streaming body", () => {
  it("renders what has arrived so far", () => {
    const bodyBlocks = bodyBlocksForTest();
    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf("the first sentence")}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
      />,
    );
    expect(container.textContent).toContain("the first sentence");
  });

  it("gives two identical settled blocks two identities", async () => {
    const bodyBlocks = bodyBlocksForTest();
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
          bodyBlocks={bodyBlocks}
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
    const bodyBlocks = bodyBlocksForTest();
    // The last line is unterminated and two blocks lag behind it, so only the first two settle.
    const { container, rerender } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf("first\n\nsecond\n\nthird\n\nfourth\n\nfifth")}
        sourceId="event-12"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
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
        bodyBlocks={bodyBlocks}
      />,
    );

    expect(container.querySelector(PARAGRAPH_SELECTOR)).toBe(firstSettled);
  });

  it("a rebase remounts rather than reusing the old message's element", () => {
    const bodyBlocks = bodyBlocksForTest();
    // Position alone would make every key unique; the text's fingerprint in the key remounts.
    const footnotes = new FootnoteRegistry();
    const { container, rerender } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(REPEATED_BLOCKS_SETTLED)}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
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
        bodyBlocks={bodyBlocks}
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
    const bodyBlocks = bodyBlocksForTest();
    const streamed = (frame: number, isComplete: boolean): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={publishedTextOf(STREAMED_FRAMES[frame] ?? "")}
        sourceId="event-40"
        footnotes={new FootnoteRegistry()}
        isComplete={isComplete}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
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

    // The tail grows twice while every parse is held.
    worker.hold();
    rerender(streamed(1, false));
    drawnFrames.push(readDrawnFrame(container));
    rerender(streamed(2, false));
    drawnFrames.push(readDrawnFrame(container));
    // The drawn tail lands at the first growth, whose parse settles a block; the shorter tail's
    // parse is held, so the block stays inside the drawn tail.
    answer((request) => !request.source.includes("five"));
    expect(drawnFrames.at(-1)?.wordCounts).toStrictEqual([1, 1, 1, 1, 0]);
    // Both tails land at the second growth, and the block moves out in the same frame.
    answer(() => true);
    expect(drawnFrames.at(-1)?.wordCounts).toStrictEqual([1, 1, 1, 1, 1]);
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
 * Whether a parse is of a text alone, against no definitions: the tail read for what it defines,
 * which a case holds while the drawn tail, parsed against the body's definitions, lands.
 */
function isReadAlone(request: { readonly source: string }): boolean {
  return !request.source.includes("<!---->");
}

describe("a streaming body still reading its tail for its definitions", () => {
  it("keeps growing its tail", () => {
    const bodyBlocks = bodyBlocksForTest();
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
        bodyBlocks={bodyBlocks}
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

    // The tail's read for the second definition stays out while the tail grows past it.
    rerender(footnoted(1));
    answerAllBut(isReadAlone);
    rerender(footnoted(2));
    answerAllBut(isReadAlone);

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
    const bodyBlocks = bodyBlocksForTest();
    // `remend` is for a prefix; on a finished body it would close emphasis the author left open.
    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(UNCLOSED_EMPHASIS)}
        sourceId="event-33"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
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
    const bodyBlocks = bodyBlocksForTest();
    renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(CROSS_BLOCK_FOOTNOTE)}
        sourceId="event-30"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
      />,
    );

    // Parsed block by block, `[^1]` would be literal text; the body's definitions are
    // restated ahead of each block so the marker exists.
    const marker = screen.getByLabelText("Footnote 1");
    expect(marker.getAttribute("data-defined")).toBe("true");
  });

  it("parses each settled block once on the page, against the tail's definitions it cites", () => {
    const bodyBlocks = bodyBlocksForTest();
    const asked = (): string[] =>
      appMarkdownWorkers.started.flatMap((worker) =>
        worker.requests.map((request) => request.source),
      );
    const askedBefore = asked().length;
    const pageParses = vi.spyOn(appMarkdownTrees, "parseSettledBlockNow");
    renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(
          "first filler[^1]\n\nsecond filler\n\nthird filler\n\nIt cites a note[^1].\n\n[^1]: the note",
        )}
        sourceId="event-31"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
      />,
    );

    // The tail is read alone for its definitions and drawn against them; a settled block is
    // parsed on the page once, against the ones it cites, and never asked of the worker.
    const citing = "first filler[^1]\n\n";
    expect(pageParses.mock.calls.filter(([source]) => source === citing)).toStrictEqual([
      [citing, definitionPreambleOf(new Set(["1"]), [])],
    ]);
    expect(
      pageParses.mock.calls.filter(([source]) => source === "second filler\n\n"),
    ).toStrictEqual([["second filler\n\n", ""]]);
    expect(
      asked()
        .slice(askedBefore)
        .filter((source) => source.endsWith(citing)),
    ).toEqual([]);
    for (const marker of screen.getAllByLabelText("Footnote 1")) {
      expect(marker.getAttribute("data-defined")).toBe("true");
    }
  });
});

describe("a body handed the reader its row's preparation read", () => {
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
    const text = publishedTextOf(`held ${CROSS_BLOCK_FOOTNOTE}`);
    const bodyBlocks = bodyBlocksForTest();
    drawnSnapshotOf(bodyBlocks, text, false);

    const { container } = renderInWindow(
      <FirstCommitProbe>
        <StreamingMarkdown
          publishedText={text}
          sourceId="event-43"
          footnotes={new FootnoteRegistry()}
          isComplete={false}
          offersBlockCopy={false}
          bodyBlocks={bodyBlocks}
        />
      </FirstCommitProbe>,
    );
    expect(firstCommitText).toContain("filler three");
    expect(firstCommitText).toBe(container.textContent);
  });
});

/**
 * The snapshot `bodyBlocks` reads of `text` once it draws, read and asked again as a row's
 * preparation does until the stand-in parser, which answers as it is asked, has drawn it.
 */
function drawnSnapshotOf(
  bodyBlocks: MarkdownBodyBlocks,
  text: PublishedText,
  isComplete: boolean,
): MarkdownBodyBlocksSnapshot {
  for (let round = 0; round < 8; round += 1) {
    const snapshot = bodyBlocks.read(text, isComplete);
    if (snapshot.isDrawn) {
      return snapshot;
    }
    bodyBlocks.requestReads();
  }
  return expect.fail("the body drew");
}

describe("a body whose text is replaced", () => {
  it("keeps drawing the old blocks' own text and trees under keys no new block takes", () => {
    const bodyBlocks = bodyBlocksForTest();
    const old = drawnSnapshotOf(bodyBlocks, publishedTextOf(REPEATED_BLOCKS_SETTLED), false);
    expect(windowedBlockKeyOf(old, 0)).toBe(0);

    // The new text's tail parse is held, so the old blocks stay drawn while it is out; no other
    // case parsed its tail, which would draw the new text at once.
    const worker = appMarkdownWorkers.latest();
    worker.hold();
    const rebased = publishedTextOf("other\n\nwords\n\nx\n\ny\n\nreplacing\n\ntail");
    const replacing = bodyBlocks.read(rebased, false);
    // The new text's cut lands as it is asked, then its tail is asked for and held.
    bodyBlocks.requestReads();
    bodyBlocks.read(rebased, false);
    bodyBlocks.requestReads();
    const stillReplacing = bodyBlocks.read(rebased, false);

    expect(stillReplacing.generation).toBe(old.generation + 1);
    expect(stillReplacing.records).toBe(old.records);
    expect(stillReplacing.settledCount).toBe(old.settledCount);
    expect(stillReplacing.readBlockSource(0)).toBe("same\n\n");
    expect(stillReplacing.readBlockTree(0).root.children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: "same" }] },
    ]);
    // A replaced block's measured size is filed under a key the new block 0 never reads.
    expect(windowedBlockKeyOf(replacing, 0)).toBe(-2);
    expect(windowedBlockKeyOf(stillReplacing, 1)).toBe(-3);

    worker.releaseWhere(() => true);
    worker.release([]);
    const replaced = drawnSnapshotOf(bodyBlocks, rebased, false);
    expect(replaced.records).not.toBe(old.records);
    expect(windowedBlockKeyOf(replaced, 0)).toBe(0);
    expect(replaced.readBlockSource(0)).toBe("other\n\n");
  });
});

/**
 * A body citing links defined after it, one inside a quote, and one label defined twice; its
 * blocks are parsed apart, so each is drawn against the body's definitions.
 */
const LINKED_BODY = [
  "See [the reader][reader], [the quote][quoted] and [twice].",
  "filler one",
  "filler two",
  "[reader]: https://example.com/reader",
  "> [quoted]: https://example.com/quoted",
  "[twice]: https://example.com/first",
  "[twice]: https://example.com/second",
  "",
].join("\n\n");

/** The text of each link a body draws; a link's address is withheld, its text kept. */
function drawnLinkTexts(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll(".meridian-markdown__link--inert")].map(
    (link) => link.textContent,
  );
}

describe("a reference link whose definition is in another block", () => {
  it("draws as a link, the first definition of a label winning", () => {
    const bodyBlocks = bodyBlocksForTest();
    const text = publishedTextOf(LINKED_BODY);
    const blocks = drawnSnapshotOf(bodyBlocksForTest(), text, true);
    // The citing block is parsed after each label's first definition, restated from its node.
    expect(blocks.readDefinitionPreamble(0)).toContain("<https://example.com/first>");
    expect(blocks.readDefinitionPreamble(0)).not.toContain("second");

    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(LINKED_BODY)}
        sourceId="event-50"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
      />,
    );

    expect(drawnLinkTexts(container)).toStrictEqual(["the reader", "the quote", "twice"]);
    expect(container.textContent).not.toContain("[");
  });

  it("is parsed again as a link once its definition arrives in the tail", () => {
    const bodyBlocks = bodyBlocksForTest();
    const head = "Use [late][late] now.\n\nfiller one\n\nfiller two\n\nthe tail";
    const streamed = (text: string): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={publishedTextOf(text)}
        sourceId="event-51"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
      />
    );
    const { container, rerender } = renderInWindow(streamed(head));
    expect(drawnLinkTexts(container)).toStrictEqual([]);
    expect(container.textContent).toContain("[late][late]");

    rerender(streamed(`${head}\n\n[late]: https://example.com/late\n\nmore`));

    expect(drawnLinkTexts(container)).toStrictEqual(["late"]);
    expect(container.textContent).not.toContain("[late]");
  });
});

/**
 * A body holding an HTML comment across a blank line and a footnote whose second paragraph is
 * indented under it: one block each in a parse of the whole body, which a cut at blank lines
 * would split, drawing `b -->` as prose and the note's second paragraph as code.
 */
const ACROSS_BLANK_LINES =
  "Intro.\n\n<!-- a\n\nb -->\n\nCites[^1].\n\n[^1]: First paragraph.\n\n" +
  "    Second paragraph of the note.\n\nAfter.\n";

describe("a body whose blocks run across blank lines", () => {
  it("draws them as one parse of the whole body does, live and saved, under the same keys", () => {
    const bodyBlocks = bodyBlocksForTest();
    const footnotes = new FootnoteRegistry();
    const streamed = (text: string, isComplete: boolean): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={publishedTextOf(text)}
        sourceId="event-52"
        footnotes={footnotes}
        isComplete={isComplete}
        offersBlockCopy={false}
        bodyBlocks={bodyBlocks}
      />
    );
    const { container, rerender } = renderInWindow(streamed(ACROSS_BLANK_LINES.slice(0, 1), false));
    for (let received = 2; received <= ACROSS_BLANK_LINES.length; received += 1) {
      rerender(streamed(ACROSS_BLANK_LINES.slice(0, received), false));
    }
    const liveParagraphs = [...container.querySelectorAll(PARAGRAPH_SELECTOR)];
    // The stored body takes over, as a lane retires.
    rerender(streamed(ACROSS_BLANK_LINES, true));
    const savedParagraphs = [...container.querySelectorAll(PARAGRAPH_SELECTOR)];

    expect(savedParagraphs.map((paragraph) => paragraph.textContent)).toStrictEqual([
      "Intro.",
      "Cites1.",
      "After.",
    ]);
    expect(container.querySelector("pre")).toBeNull();
    // The blocks settled live keep their elements once the stored body takes over.
    expect(savedParagraphs[0]).toBe(liveParagraphs[0]);
    expect(savedParagraphs[1]).toBe(liveParagraphs[1]);
    expect(footnotes.definitionsFor("event-52").get("1")?.bodyNodes).toMatchObject([
      { type: "paragraph" },
      { type: "paragraph", children: [{ type: "text", value: "Second paragraph of the note." }] },
    ]);

    const saved = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(ACROSS_BLANK_LINES)}
        sourceId="event-52"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersBlockCopy={false}
        bodyBlocks={bodyBlocksForTest()}
      />,
    );
    expect(saved.container.innerHTML).toBe(container.innerHTML);
  });
});
