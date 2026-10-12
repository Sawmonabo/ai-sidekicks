// A call's output, colored or plain, is cut at a quarter of the visible flow in whole lines of its
// own type, painting nothing of the line past the cut, a text size step moves the cut with the
// lines, and `Show all` draws the whole output in place. A running command's output shows its last
// whole lines and follows each new one, its rest offered under the bytes arrived so far. Whether
// an output runs past the cut is known in the commit that cuts it, so the conversation measures its
// row with `Show all` in that frame, except in a row a screen above the box, which takes it from
// its first report and draws it as the next frame starts, or at once if a scroll brings it into
// the box first, raising no resize loop; the outputs one commit brings in, their cuts and their
// line windows, are read together, laid out once. Measured in Chromium, since the cut is CSS line
// units over the scroller's measured height.

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { cdp } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { openPagedSessionStore } from "#renderer/features/transcript/logs.test-support.js";
import { PreparedBodiesContext } from "#renderer/features/transcript/rows/prepared-bodies.js";
import { OUTPUT_CUT_FLOW_SHARE } from "#renderer/features/transcript/rows/bodies/hooks/useOutputHeightCut.js";
import { type OutputOpening } from "#renderer/features/transcript/rows/bodies/OutputHeightCut.js";
import { ToolOutput } from "#renderer/features/transcript/rows/bodies/ToolOutput.js";
import {
  SuiteWindowViewportProvider,
  suiteWindowViewport,
} from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { type TranscriptBodyViewport } from "#renderer/components/TranscriptBodyViewport/context.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import { prepareRowBodiesForTest } from "#renderer/features/transcript/rows/preparation.test-support.js";
import {
  publishedTextOf,
  type PublishedText,
} from "#renderer/features/transcript/reveal/published-text.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import { readerScrollsTo } from "../../helpers/transcript/reader-scroll.js";
import { hearResizeLoopErrors } from "./resize-loop-errors.js";
import { traceAlone } from "../trace-lock.js";
import { sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
import { letFramesPassUntilStill } from "../../helpers/animation-frame.js";
import { toolOutputEventAt } from "./colored-output-event.js";
import { FEED_HEIGHT_PX, ROW_SELECTOR, mountTranscriptFeed } from "./long-tool-feed.js";
import { settleFrames } from "./windowed/reply.js";

const SCROLLER_HEIGHT_PX = 600;
const PRINTED_LINE_COUNT = 120;
/** The lines a running command prints after it is first drawn. */
const ARRIVING_LINE_COUNT = 10;
const ESCAPE = String.fromCodePoint(0x1b);
const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));
/** The calls in the feed one commit brings a band of outputs in from. */
const FEED_OUTPUT_COUNT = 60;
/**
 * The fewest outputs the jump brings in, as a fling's entering rows do: those in view with its
 * commit, parsed whole as they come into it, and the band's others as their parse lands.
 */
const MIN_OUTPUTS_BROUGHT_IN = 5;
/** The frames the feed holds still for once the band the jump brought in has landed. */
const BAND_STILL_FRAME_COUNT = 3;
/** Every drawn output, its box and its `Show all`. */
const OUTPUT_SELECTOR = ".meridian-output-cut";
/** An output's box while it is cut. */
const CUT_BODY_SELECTOR = ".meridian-output-cut__body--cut";
/** The control that draws an output whole. */
const SHOW_ALL_SELECTOR = ".meridian-full-output";
/**
 * The reads a mounting output makes, as the trace's stack frames name them: its cut's first answer
 * and its line window's type.
 */
const MOUNT_READ_FUNCTION_NAMES: readonly string[] = ["readFirstAnswer", "readTypeOnMount"];

afterEach(() => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

/** The box's content edges on screen: its laid-out box less its borders and padding. */
function contentEdgesPx(box: HTMLElement): { readonly top: number; readonly bottom: number } {
  const style = getComputedStyle(box);
  const rect = box.getBoundingClientRect();
  return {
    top: rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
    bottom: rect.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom),
  };
}

/** The box's drawn content height, unrounded. */
function drawnContentHeightPx(box: HTMLElement): number {
  const edges = contentEdgesPx(box);
  return edges.bottom - edges.top;
}

/** The cut the box should stand at: the flow's share, rounded down to its whole lines. */
function expectedCutPx(box: HTMLElement): number {
  const lineHeightPx = parseFloat(getComputedStyle(box).lineHeight);
  return Math.floor((SCROLLER_HEIGHT_PX * OUTPUT_CUT_FLOW_SHARE) / lineHeightPx) * lineHeightPx;
}

/** The one element `selector` names, which the case drew. */
function drawnElement(container: HTMLElement, selector: string): HTMLElement {
  return container.querySelector<HTMLElement>(selector) ?? expect.fail(`${selector} is drawn`);
}

/** A mark at each printed line's end, three bytes in UTF-8, so the output's bytes outnumber it. */
const LINE_MARK = " ✓";

/** The printed line `line`, named for its place. */
function printedLine(line: number): string {
  return `line ${String(line)}${LINE_MARK}`;
}

/** `count` printed lines. */
function printedLines(count: number): string {
  return Array.from({ length: count }, (_line, index) => printedLine(index + 1)).join("\n");
}

/**
 * Whether the printed line `line` stands wholly inside the box's content edges, so it is seen; a
 * line the output's window holds undrawn is not.
 */
function isLineSeen(box: HTMLElement, line: number): boolean {
  const lineText = printedLine(line);
  // Each line is drawn inside one text node of its chunk's.
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let text: Text | undefined;
  let start = -1;
  for (let node = walker.nextNode(); node !== null && start === -1; node = walker.nextNode()) {
    text = node as Text;
    start = `\n${text.data}\n`.indexOf(`\n${lineText}\n`);
  }
  if (text === undefined || start === -1) {
    return false;
  }
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + lineText.length);
  const lineRect = range.getBoundingClientRect();
  const edges = contentEdgesPx(box);
  return lineRect.top >= edges.top - 0.5 && lineRect.bottom <= edges.bottom + 0.5;
}

/** The row a held call's output belongs to, unless the case names another. */
const HELD_CALL_ROW_KEY = "call";

/**
 * A call's output whose opening the case holds, as the feed does, so a press repaints it, prepared
 * as the feed prepares its row and read again as its live text grows.
 */
function HeldToolOutput(props: {
  readonly body: string;
  readonly liveText?: PublishedText;
  readonly rowKey?: string;
}): React.JSX.Element {
  const rowKey = props.rowKey ?? HELD_CALL_ROW_KEY;
  const [isOpened, setIsOpened] = useState(false);
  const [liveTexts] = useState(() => new Map<string, PublishedText>());
  const [prepared] = useState(() => {
    if (props.liveText !== undefined) {
      liveTexts.set(rowKey, props.liveText);
    }
    return prepareRowBodiesForTest(
      [
        sampleRunRow({
          id: rowKey,
          type: "tool.result",
          content: { status: "available", body: props.body },
        }),
      ],
      liveTexts,
    );
  });
  // A new live text is read before the body draws it, as the feed reads each drained frame.
  if (props.liveText !== undefined && liveTexts.get(rowKey) !== props.liveText) {
    liveTexts.set(rowKey, props.liveText);
    prepared.refresh();
  }
  const opening: OutputOpening = {
    isOpened,
    open: () => {
      setIsOpened(true);
    },
  };
  return (
    <PreparedBodiesContext value={prepared.bodies}>
      <ToolOutput
        content={{ status: "available", body: props.body }}
        {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
        sourceId={rowKey}
        footnotes={new FootnoteRegistry()}
        label="Output"
        opening={opening}
      />
    </PreparedBodiesContext>
  );
}

/**
 * The outputs drawn in a measured scroller, as a transcript's list draws them; `rowEndPx`, when
 * given, is where the conversation lays the rows' ends.
 */
async function renderInScroller(
  children: React.ReactNode,
  rowEndPx?: TranscriptBodyViewport["rowEndPx"],
): Promise<{
  readonly container: HTMLElement;
  readonly rerender: (children: React.ReactNode) => void;
}> {
  installMeridianTokens(document);
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const suiteViewport = suiteWindowViewport(scrollController, {
    subscribe: () => () => undefined,
    read: () => undefined,
  });
  const viewport =
    rowEndPx === undefined ? suiteViewport : { ...suiteViewport, rowEndPx: rowEndPx };
  const scroller = (drawn: React.ReactNode): React.JSX.Element => (
    <div
      ref={(element) => {
        if (element === null) {
          scrollController.detach();
        } else {
          scrollController.attach(element);
        }
      }}
      style={{ height: `${String(SCROLLER_HEIGHT_PX)}px`, overflowY: "scroll" }}
    >
      <SuiteWindowViewportProvider viewport={viewport}>
        {/* One row, as a transcript's list draws it, which a long output's window places itself in. */}
        <div {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: 0 }}>{drawn}</div>
      </SuiteWindowViewportProvider>
    </div>
  );
  // The outputs a commit brings in are read once it is done, before the frame paints, in the same
  // act scope as the commit.
  const rendered = await act(async () => {
    const result = render(scroller(children));
    await Promise.resolve();
    return result;
  });
  return {
    container: rendered.container,
    rerender: (drawn) => {
      rendered.rerender(scroller(drawn));
    },
  };
}

/** What a frame shows of the outputs before its own layout: how many are cut, and `Show all`s. */
interface CutFrame {
  readonly cutCount: number;
  readonly showAllCount: number;
}

/**
 * What each of the next `count` frames shows of the outputs `outputsOf` answers as it starts,
 * before the frame's layout and its resize reports: what the commits before it drew.
 */
function recordCutFrames(outputsOf: () => readonly Element[], count: number): Promise<CutFrame[]> {
  const frames: CutFrame[] = [];
  return new Promise((resolve) => {
    const record = (): void => {
      const outputs = outputsOf();
      frames.push({
        cutCount: outputs.filter((output) => output.querySelector(CUT_BODY_SELECTOR) !== null)
          .length,
        showAllCount: outputs.filter((output) => output.querySelector(SHOW_ALL_SELECTOR) !== null)
          .length,
      });
      if (frames.length === count) {
        resolve(frames);
      } else {
        requestAnimationFrame(record);
      }
    };
    requestAnimationFrame(record);
  });
}

/** The frames a case's render may take to cut an output: two seconds of frames at 60 a second. */
const CUT_FRAME_LIMIT = 120;

/**
 * What each of the `count` frames after the commit that first cuts an output shows of the outputs
 * drawn, as `recordCutFrames` reads them, counted from that commit rather than from when the case
 * next runs: an awaited `act` returns a task later, and a busy machine starts a frame in between.
 * `onCut` runs in the commit's own task, before any frame starts. Rejects once `CUT_FRAME_LIMIT`
 * frames pass with no output cut.
 */
function recordCutFramesFromCut(count: number, onCut: () => void = () => {}): Promise<CutFrame[]> {
  return new Promise((resolve, reject) => {
    let framesWithoutCut = 0;
    let frameRequest = 0;
    const changes = new MutationObserver(() => {
      if (document.querySelector(CUT_BODY_SELECTOR) !== null) {
        changes.disconnect();
        cancelAnimationFrame(frameRequest);
        onCut();
        resolve(recordCutFrames(() => outputsIn(document.body), count));
      }
    });
    const countFrame = (): void => {
      framesWithoutCut += 1;
      if (framesWithoutCut >= CUT_FRAME_LIMIT) {
        changes.disconnect();
        reject(new Error(`no output was cut within ${String(CUT_FRAME_LIMIT)} frames`));
        return;
      }
      frameRequest = requestAnimationFrame(countFrame);
    };
    changes.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    frameRequest = requestAnimationFrame(countFrame);
  });
}

/** The outputs drawn in `container`. */
function outputsIn(container: Element): Element[] {
  return [...container.querySelectorAll(OUTPUT_SELECTOR)];
}

/**
 * The outputs in `scroller` whose rows end well under a screen above its box: they read their
 * heights at once, while a row a screen above takes its first answer from its first report.
 */
function outputsReadAtOnce(scroller: HTMLElement): Element[] {
  const readsFromPx = scroller.getBoundingClientRect().top - FEED_HEIGHT_PX / 2;
  return outputsIn(scroller).filter(
    (output) =>
      (output.closest(ROW_SELECTOR)?.getBoundingClientRect().bottom ?? readsFromPx) > readsFromPx,
  );
}

/** How far the end of `output`'s row sits below the top of `scroller`'s box, in pixels. */
function rowEndBelowBoxTopPx(scroller: HTMLElement, output: Element): number {
  const row = output.closest(ROW_SELECTOR) ?? expect.fail("the output is drawn in a row");
  return row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
}

/** The label of the time stamp a case leaves in the trace as a commit brings outputs in. */
const OUTPUTS_COMMITTED_LABEL = "outputs committed";

/**
 * Stamps the trace as each commit brings outputs into `scroller`, ahead of the reads the commit
 * arms, and keeps how many each brought in, until `stop`. It reads no layout, which would lay the
 * page out ahead of those reads.
 */
function stampOutputCommits(scroller: HTMLElement): {
  readonly outputCounts: readonly number[];
  readonly stop: () => void;
} {
  const seen = new Set(outputsIn(scroller));
  const outputCounts: number[] = [];
  const observer = new MutationObserver(() => {
    const added = outputsIn(scroller).filter((output) => !seen.has(output));
    if (added.length === 0) {
      return;
    }
    for (const output of added) {
      seen.add(output);
    }
    outputCounts.push(added.length);
    console.timeStamp(OUTPUTS_COMMITTED_LABEL);
  });
  observer.observe(scroller, { childList: true, subtree: true });
  return {
    outputCounts,
    stop: () => {
      observer.disconnect();
    },
  };
}

/** One frame of a trace event's script stack. */
interface StackFrame {
  readonly url: string;
  readonly functionName: string;
}

/** One trace event of Chromium's main thread, as far as the count reads it. */
interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  /** When it began, in the trace's clock. */
  readonly ts: number;
  readonly args?: {
    readonly beginData?: {
      readonly stackTrace?: readonly StackFrame[];
      /** The frame whose document it ran in. */
      readonly frame?: string;
    };
    readonly data?: {
      readonly stackTrace?: readonly StackFrame[];
      /** The frame whose document it ran in. */
      readonly frame?: string;
      /** A time stamp's label. */
      readonly message?: string;
    };
  };
}

/** The style passes and layouts script forced in a stretch of the trace. */
interface ForcedLayoutPasses {
  readonly styleRecalcs: number;
  readonly layouts: number;
}

/**
 * The style passes and layouts a function named in `functionNames` forced while `run` ran, read
 * from a trace of the page: a pass the frame runs carries no script stack, and one script forced
 * names its callers. They are counted apart before the first time stamp labeled
 * `OUTPUTS_COMMITTED_LABEL` and after each, in the stamps' frame only: the trace holds every page
 * of the browser, and the runner runs other test files in pages of their own at the same time.
 */
async function forcedLayoutPassesByCommitOf(
  functionNames: readonly string[],
  run: () => Promise<void>,
): Promise<readonly ForcedLayoutPasses[]> {
  const text = await traceAlone(async () => {
    const session = cdp();
    // The runner opens its protocol session on the first call; a listener added before that can
    // land on a second session the trace never reports to.
    await session.send("Tracing.getCategories");
    // The trace is read back as a stream, whose handle the end announces.
    const stream = new Promise<string>((resolve) => {
      session.on("Tracing.tracingComplete", (payload) => {
        resolve(payload.stream ?? expect.fail("the trace is returned as a stream"));
      });
    });
    await session.send("Tracing.start", {
      traceConfig: {
        includedCategories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.stack",
        ],
      },
      transferMode: "ReturnAsStream",
    });
    await run();
    await session.send("Tracing.end");
    const handle = await stream;
    let streamed = "";
    for (let isAtEnd = false; !isAtEnd; ) {
      const chunk = await session.send("IO.read", { handle });
      streamed += chunk.data;
      isAtEnd = chunk.eof;
    }
    await session.send("IO.close", { handle });
    return streamed;
  });
  const { traceEvents } = JSON.parse(text) as { readonly traceEvents: readonly TraceEvent[] };
  const stamps = traceEvents.filter(
    (event) => event.name === "TimeStamp" && event.args?.data?.message === OUTPUTS_COMMITTED_LABEL,
  );
  const caseFrame =
    stamps[0]?.args?.data?.frame ?? expect.fail("a commit stamps the trace from the case's frame");
  const stretchStarts = [
    -Infinity,
    ...stamps.map((event) => event.ts).sort((earlier, later) => earlier - later),
  ];
  const forced = traceEvents.filter(
    (event) =>
      event.ph === "X" &&
      (event.args?.beginData?.frame ?? event.args?.data?.frame) === caseFrame &&
      (event.args?.beginData?.stackTrace ?? event.args?.data?.stackTrace ?? []).some((frame) =>
        functionNames.includes(frame.functionName),
      ),
  );
  return stretchStarts.map((start, stretch) => {
    const end = stretchStarts[stretch + 1] ?? Infinity;
    const forcedBy = (name: string): number =>
      forced.filter((event) => event.name === name && event.ts >= start && event.ts < end).length;
    return { styleRecalcs: forcedBy("UpdateLayoutTree"), layouts: forcedBy("Layout") };
  });
}

describe("a call's output cut at the visible flow", () => {
  it("cuts at whole lines, paints none of the next, follows the text size, opens in place", async () => {
    const coloredOutput = Array.from(
      { length: PRINTED_LINE_COUNT },
      (_line, index) => `${ESCAPE}[32mok${ESCAPE}[39m line ${String(index + 1)}`,
    ).join("\n");
    const { container } = await renderInScroller(
      <>
        <div data-call="colored">
          <HeldToolOutput body={coloredOutput} rowKey="colored-call" />
        </div>
        <div data-call="plain">
          <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} rowKey="plain-call" />
        </div>
      </>,
    );
    await settleFrames();
    const colored = drawnElement(container, ".meridian-ansi__body");
    const plain = drawnElement(container, ".meridian-machine-body__plain");

    // The cut is in force on both: whole lines of each box's own type, the rest one press away.
    for (const box of [colored, plain]) {
      expect(drawnContentHeightPx(box)).toBeCloseTo(expectedCutPx(box), 0);
    }
    const defaultCutPx = expectedCutPx(colored);
    const coloredCall = drawnElement(container, '[data-call="colored"]');
    const control = within(coloredCall).getByRole("button", { name: "Show all" });
    within(drawnElement(container, '[data-call="plain"]')).getByRole("button", {
      name: "Show all",
    });

    // The line past the cut runs on under the box's bottom padding, where nothing of it paints:
    // what stands there is the box itself, not the next line's colored run.
    const coloredStyle = getComputedStyle(colored);
    const coloredRect = colored.getBoundingClientRect();
    const underCutPoint = {
      x: coloredRect.left + parseFloat(coloredStyle.paddingLeft) + 2,
      y: contentEdgesPx(colored).bottom + parseFloat(coloredStyle.paddingBottom) / 2,
    };
    expect(document.elementFromPoint(underCutPoint.x, underCutPoint.y)).toBe(colored);

    // A text size step moves the cut with the lines it counts.
    applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });
    await settleFrames();
    const largestCutPx = expectedCutPx(colored);
    expect(largestCutPx).not.toBeCloseTo(defaultCutPx, 0);
    expect(drawnContentHeightPx(colored)).toBeCloseTo(largestCutPx, 0);

    // The press opens it, and the whole output draws where it stands.
    await act(async () => {
      control.click();
      await Promise.resolve();
    });
    await settleFrames();
    expect(colored.scrollHeight).toBe(colored.clientHeight);
    expect(within(coloredCall).queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("shows a running command's last whole lines and follows each new one", async () => {
    const firstOutput = printedLines(PRINTED_LINE_COUNT);
    const runningOutput = (body: string): React.JSX.Element => (
      <HeldToolOutput body={body} liveText={publishedTextOf(body)} />
    );
    const { container, rerender } = await renderInScroller(runningOutput(firstOutput));
    await settleFrames();
    const box = drawnElement(container, ".meridian-machine-body__plain");
    const lastFirstLine = PRINTED_LINE_COUNT;
    const seenFirst = {
      first: isLineSeen(box, 1),
      last: isLineSeen(box, lastFirstLine),
    };

    const grownOutput = printedLines(PRINTED_LINE_COUNT + ARRIVING_LINE_COUNT);
    rerender(runningOutput(grownOutput));
    await settleFrames();

    // The cut box stands at whole lines, the newest at its foot, the rest one press away.
    expect(drawnContentHeightPx(box)).toBeCloseTo(expectedCutPx(box), 0);
    expect(seenFirst).toStrictEqual({ first: false, last: true });
    expect(isLineSeen(box, PRINTED_LINE_COUNT + ARRIVING_LINE_COUNT)).toBe(true);
    expect(isLineSeen(box, lastFirstLine)).toBe(false);
    // Its rest is offered under the bytes arrived so far, never a line count.
    expect(drawnElement(container, SHOW_ALL_SELECTOR).textContent).toBe(
      `Show full output (${formatByteQuantity(measureUtf8ByteLength(grownOutput)).text})`,
    );
  });

  it("knows an output runs past the cut in the commit that cuts it, but from its first report in a row a screen above the box", async () => {
    // In view, the commit that cuts the output draws `Show all` too, so no frame starts with the
    // cut drawn and `Show all` missing, which the conversation would measure the row without.
    const inViewRecording = recordCutFramesFromCut(6);
    await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => SCROLLER_HEIGHT_PX / 2,
    );
    const inViewFrames = await act(async () => await inViewRecording);
    expect(inViewFrames.some((frame) => frame.cutCount > 0)).toBe(true);
    expect(inViewFrames.filter((frame) => frame.cutCount > frame.showAllCount)).toStrictEqual([]);
    cleanup();

    // A screen above the box, the first resize report answers it, in the frame that cut it, and
    // `Show all` is drawn as the next frame starts, before a fling can bring the row into the box:
    // the third frame starts with what the second drew.
    const aboveRecording = recordCutFramesFromCut(6);
    await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => -SCROLLER_HEIGHT_PX,
    );
    const aboveFrames = await act(async () => await aboveRecording);
    expect(aboveFrames.slice(0, 2)).toStrictEqual([
      { cutCount: 1, showAllCount: 0 },
      { cutCount: 1, showAllCount: 0 },
    ]);
    expect(aboveFrames.slice(2).filter((frame) => frame.showAllCount === 0)).toStrictEqual([]);
    cleanup();

    // Brought to within a screen of the box but still above it at the report, the row draws
    // `Show all` as the next frame starts, as one a screen above does.
    let nearRowEndPx = -SCROLLER_HEIGHT_PX;
    const nearRecording = recordCutFramesFromCut(6, () => {
      nearRowEndPx = -SCROLLER_HEIGHT_PX / 2;
    });
    await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => nearRowEndPx,
    );
    const nearFrames = await act(async () => await nearRecording);
    expect(nearFrames.slice(0, 2)).toStrictEqual([
      { cutCount: 1, showAllCount: 0 },
      { cutCount: 1, showAllCount: 0 },
    ]);
    cleanup();

    // A screen above when cut but brought into the box before its first report with no scroll,
    // the row draws `Show all` in the frame of that report, before it paints.
    let rowEndPx = -SCROLLER_HEIGHT_PX;
    const broughtNearerRecording = recordCutFramesFromCut(6, () => {
      rowEndPx = SCROLLER_HEIGHT_PX / 2;
    });
    await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => rowEndPx,
    );
    const broughtNearerFrames = await act(async () => await broughtNearerRecording);
    expect(broughtNearerFrames[0]).toStrictEqual({ cutCount: 1, showAllCount: 0 });
    expect(broughtNearerFrames.slice(1).filter((frame) => frame.showAllCount === 0)).toStrictEqual(
      [],
    );
  });

  it("reads the outputs one commit brings in together, each cut with `Show all` from its first frame", async () => {
    const { scroller } = await mountTranscriptFeed(
      openPagedSessionStore(0, FEED_OUTPUT_COUNT - 1, undefined, (index) =>
        toolOutputEventAt(index, printedLines(PRINTED_LINE_COUNT)),
      ),
      undefined,
    );
    const resizeLoopErrors = hearResizeLoopErrors();
    const commits = stampOutputCommits(scroller);
    let frames: CutFrame[] = [];
    const forcedPasses = await forcedLayoutPassesByCommitOf(MOUNT_READ_FUNCTION_NAMES, async () => {
      // The reader leaves the tail and the offset jumps two screens toward the head. Its commit
      // brings in the outputs in view, parsed whole as they come into it, and the reads it arms
      // run before the first frame; the band's others mount as their parse lands, in commits of
      // their own, each read with its commit's other outputs. The count runs until the band is
      // whole.
      act(() => {
        readerScrollsTo(scroller, scroller.scrollTop - 2 * FEED_HEIGHT_PX);
      });
      frames = await act(async () => await recordCutFrames(() => outputsReadAtOnce(scroller), 6));
      await letFramesPassUntilStill(scroller, BAND_STILL_FRAME_COUNT);
    });
    commits.stop();

    // The jump's commit brings in several outputs, so a read for each would force a pass for each.
    const [outputsWithJump = 0, ...outputsWithBand] = commits.outputCounts;
    expect(outputsWithJump).toBeGreaterThan(1);
    expect(
      outputsWithBand.reduce((total, count) => total + count, outputsWithJump),
    ).toBeGreaterThanOrEqual(MIN_OUTPUTS_BROUGHT_IN);
    // One style pass and one layout for the outputs each commit brings in, their cuts and their
    // line windows, not one for each: none before the jump's commit, one for it, and at most one
    // for each of the band's.
    const [beforeJump, withJump, ...withBand] = forcedPasses;
    expect({ beforeJump, withJump }).toStrictEqual({
      beforeJump: { styleRecalcs: 0, layouts: 0 },
      withJump: { styleRecalcs: 1, layouts: 1 },
    });
    expect(
      withBand.filter((passes) => passes.styleRecalcs > 1 || passes.layouts > 1),
    ).toStrictEqual([]);
    expect(frames[0]?.cutCount).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame.cutCount > frame.showAllCount)).toStrictEqual([]);
    expect(resizeLoopErrors.stop()).toStrictEqual([]);
  });

  it("draws `Show all` before the frame lays out for a far row a scroll brings into the box before its first report", async () => {
    const { scroller } = await mountTranscriptFeed(
      openPagedSessionStore(0, FEED_OUTPUT_COUNT - 1, undefined, (index) =>
        toolOutputEventAt(index, printedLines(PRINTED_LINE_COUNT)),
      ),
      undefined,
    );
    const resizeLoopErrors = hearResizeLoopErrors();
    // The jump brings the outputs in view in with one commit; the band's others above the box
    // mount as their parse lands, a screen above, waiting for their first report. The commit that
    // mounts those within half a screen more of it is answered by a scroll moving them into the
    // box before any frame.
    act(() => {
      readerScrollsTo(scroller, scroller.scrollTop - 2 * FEED_HEIGHT_PX);
    });
    const drawnAtJump = new Set(outputsIn(scroller));
    const { outputsInBox, frames } = await act(
      async () =>
        await new Promise<{
          readonly outputsInBox: readonly Element[];
          readonly frames: Promise<CutFrame[]>;
        }>((resolve) => {
          const observer = new MutationObserver(() => {
            const farOutputs = outputsIn(scroller).filter((output) => {
              const rowEndPx = rowEndBelowBoxTopPx(scroller, output);
              return (
                !drawnAtJump.has(output) &&
                rowEndPx <= -FEED_HEIGHT_PX &&
                rowEndPx > -1.5 * FEED_HEIGHT_PX
              );
            });
            if (farOutputs.length === 0) {
              return;
            }
            observer.disconnect();
            scroller.scrollTop -= 1.5 * FEED_HEIGHT_PX;
            fireEvent.scroll(scroller);
            const inBox = farOutputs.filter((output) => rowEndBelowBoxTopPx(scroller, output) > 0);
            // Recorded from the next frame on, the first the scroll lets come.
            resolve({ outputsInBox: inBox, frames: recordCutFrames(() => inBox, 6) });
          });
          observer.observe(scroller, { childList: true, subtree: true });
        }),
    );
    const recordedFrames = await act(async () => await frames);

    expect(outputsInBox.length).toBeGreaterThan(0);
    expect(recordedFrames.filter((frame) => frame.cutCount > frame.showAllCount)).toStrictEqual([]);
    expect(resizeLoopErrors.stop()).toStrictEqual([]);
  });
});
