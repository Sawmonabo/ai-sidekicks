// A call's output, colored or plain, is cut at a quarter of the visible flow in whole lines of its
// own type, painting nothing of the line past the cut, a text size step moves the cut with the
// lines, and `Show all` draws the whole output in place. A running command's output shows its last
// whole lines and follows each new one, its rest offered under the bytes arrived so far. Whether
// an output runs past the cut is known in the commit that cuts it, so the conversation measures its
// row with `Show all` in that frame, except in a row a screen above the box, which takes it from
// its first report and draws it as the next frame starts, raising no resize loop; the outputs one
// commit brings in are read together, laid out once. Measured in Chromium, since the cut is CSS
// line units over the scroller's measured height.

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { cdp } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { openPagedSessionStore } from "#renderer/features/transcript/logs.test-support.js";
import { PreparedAnsiOutputsContext } from "#renderer/features/transcript/rows/ansi/preparation.js";
import { prepareOutputForTest } from "#renderer/features/transcript/rows/ansi/preparation.test-support.js";
import { OUTPUT_CUT_FLOW_SHARE } from "#renderer/features/transcript/rows/bodies/hooks/useOutputHeightCut.js";
import { type OutputOpening } from "#renderer/features/transcript/rows/bodies/OutputHeightCut.js";
import { ToolOutput } from "#renderer/features/transcript/rows/bodies/ToolOutput.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import {
  MarkdownWindowViewportContext,
  type MarkdownWindowViewport,
} from "#renderer/features/transcript/rows/markdown/block-window/context.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import { prepareTranscriptRow } from "#renderer/features/transcript/rows/preparation.js";
import {
  publishedTextOf,
  type PublishedText,
} from "#renderer/features/transcript/reveal/published-text.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
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
/** The fewest outputs the jump brings in with one commit, as a fling's entering rows do. */
const MIN_OUTPUTS_IN_ONE_COMMIT = 5;
/** Every drawn output, its box and its `Show all`. */
const OUTPUT_SELECTOR = ".meridian-output-cut";
/** An output's box while it is cut. */
const CUT_BODY_SELECTOR = ".meridian-output-cut__body--cut";
/** The control that draws an output whole. */
const SHOW_ALL_SELECTOR = ".meridian-full-output";
/** The module whose reads the trace counts, as its stack frames name it. */
const useOutputHeightCutModuleName = "useOutputHeightCut.ts";

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

/** Whether the printed line `line` stands wholly inside the box's content edges, so it is seen. */
function isLineSeen(box: HTMLElement, line: number): boolean {
  const text = box.querySelector(".meridian-output-cut__content")?.firstChild;
  if (!(text instanceof Text)) {
    return expect.fail("the plain output is one text node");
  }
  const lineText = printedLine(line);
  const start = `\n${text.data}\n`.indexOf(`\n${lineText}\n`);
  if (start === -1) {
    return expect.fail(`the output prints ${lineText}`);
  }
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + lineText.length);
  const lineRect = range.getBoundingClientRect();
  const edges = contentEdgesPx(box);
  return lineRect.top >= edges.top - 0.5 && lineRect.bottom <= edges.bottom + 0.5;
}

/** The row every held call's output belongs to. */
const HELD_CALL_ROW_KEY = "call";

/** A call's output whose opening the case holds, as the feed does, so a press repaints it. */
function HeldToolOutput(props: {
  readonly body: string;
  readonly liveText?: PublishedText;
}): React.JSX.Element {
  const [isOpened, setIsOpened] = useState(false);
  const opening: OutputOpening = {
    isOpened,
    open: () => {
      setIsOpened(true);
    },
  };
  return (
    <ToolOutput
      content={{ status: "available", body: props.body }}
      {...(props.liveText === undefined ? {} : { liveText: props.liveText })}
      sourceId={HELD_CALL_ROW_KEY}
      footnotes={new FootnoteRegistry()}
      label="Output"
      opening={opening}
    />
  );
}

/**
 * The outputs drawn in a measured scroller, as a transcript's list draws them; `rowEndPx`, when
 * given, is where the conversation lays the rows' ends.
 */
async function renderInScroller(
  children: React.ReactNode,
  rowEndPx?: MarkdownWindowViewport["rowEndPx"],
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
      <MarkdownWindowViewportContext value={viewport}>{drawn}</MarkdownWindowViewportContext>
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

/** One trace event of Chromium's main thread, as far as the count reads it. */
interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly args?: {
    readonly beginData?: { readonly stackTrace?: readonly { readonly url: string }[] };
    readonly data?: { readonly stackTrace?: readonly { readonly url: string }[] };
  };
}

/**
 * The style passes and layouts script in `moduleName` forced while `run` ran, read from a trace of
 * the page: a pass the frame runs carries no script stack, and one script forced names it.
 */
async function forcedLayoutPassesOf(
  moduleName: string,
  run: () => Promise<void>,
): Promise<{ readonly styleRecalcs: number; readonly layouts: number }> {
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
  let text = "";
  for (let isAtEnd = false; !isAtEnd; ) {
    const chunk = await session.send("IO.read", { handle });
    text += chunk.data;
    isAtEnd = chunk.eof;
  }
  await session.send("IO.close", { handle });
  const { traceEvents } = JSON.parse(text) as { readonly traceEvents: readonly TraceEvent[] };
  const forcedBy = (name: string): number =>
    traceEvents.filter(
      (event) =>
        event.name === name &&
        event.ph === "X" &&
        (event.args?.beginData?.stackTrace ?? event.args?.data?.stackTrace ?? []).some((frame) =>
          frame.url.includes(moduleName),
        ),
    ).length;
  return { styleRecalcs: forcedBy("UpdateLayoutTree"), layouts: forcedBy("Layout") };
}

describe("a call's output cut at the visible flow", () => {
  it("cuts at whole lines, paints none of the next, follows the text size, opens in place", async () => {
    const coloredOutput = Array.from(
      { length: PRINTED_LINE_COUNT },
      (_line, index) => `${ESCAPE}[32mok${ESCAPE}[39m line ${String(index + 1)}`,
    ).join("\n");
    const prepared = prepareOutputForTest(HELD_CALL_ROW_KEY, coloredOutput);
    const { container } = await renderInScroller(
      <PreparedAnsiOutputsContext value={prepared.outputs}>
        <div data-call="colored">
          <HeldToolOutput body={coloredOutput} />
        </div>
        <div data-call="plain">
          <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />
        </div>
      </PreparedAnsiOutputsContext>,
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
    const inView = await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => SCROLLER_HEIGHT_PX / 2,
    );
    const inViewFrames = await act(
      async () => await recordCutFrames(() => outputsIn(inView.container), 6),
    );
    expect(inViewFrames.some((frame) => frame.cutCount > 0)).toBe(true);
    expect(inViewFrames.filter((frame) => frame.cutCount > frame.showAllCount)).toStrictEqual([]);
    cleanup();

    // A screen above the box, the first resize report answers it, in the frame that cut it, and
    // `Show all` is drawn as the next frame starts, before a fling can bring the row into the box:
    // the third frame starts with what the second drew.
    const above = await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => -SCROLLER_HEIGHT_PX,
    );
    const aboveFrames = await act(
      async () => await recordCutFrames(() => outputsIn(above.container), 6),
    );
    expect(aboveFrames.slice(0, 2)).toStrictEqual([
      { cutCount: 1, showAllCount: 0 },
      { cutCount: 1, showAllCount: 0 },
    ]);
    expect(aboveFrames.slice(2).filter((frame) => frame.showAllCount === 0)).toStrictEqual([]);
    cleanup();

    // A screen above when cut but brought nearer before its first report, the row draws `Show all`
    // in the frame of that report, before it paints.
    let rowEndPx = -SCROLLER_HEIGHT_PX;
    const broughtNearer = await renderInScroller(
      <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />,
      () => rowEndPx,
    );
    rowEndPx = SCROLLER_HEIGHT_PX / 2;
    const broughtNearerFrames = await act(
      async () => await recordCutFrames(() => outputsIn(broughtNearer.container), 6),
    );
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
      undefined,
      undefined,
      prepareTranscriptRow,
    );
    const drawnBefore = new Set(scroller.querySelectorAll(OUTPUT_SELECTOR));
    // A row that grows inside a resize report leaves the conversation's report of it undelivered,
    // which the browser raises as an error the run would only log.
    const resizeLoopErrors: string[] = [];
    const hearResizeLoopError = (event: ErrorEvent): void => {
      if (event.message.includes("ResizeObserver loop")) {
        resizeLoopErrors.push(event.message);
      }
    };
    window.addEventListener("error", hearResizeLoopError);
    let entered: Element[] = [];
    let frames: CutFrame[] = [];
    const forcedPasses = await forcedLayoutPassesOf(useOutputHeightCutModuleName, async () => {
      // The reader leaves the tail and the offset jumps two screens toward the head, bringing a
      // band of outputs in with one commit; the reads it arms run before the first frame.
      act(() => {
        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -FEED_HEIGHT_PX }));
        scroller.scrollTop -= 2 * FEED_HEIGHT_PX;
        fireEvent.scroll(scroller);
      });
      entered = [...scroller.querySelectorAll(OUTPUT_SELECTOR)].filter(
        (output) => !drawnBefore.has(output),
      );
      frames = await act(async () => await recordCutFrames(() => outputsReadAtOnce(scroller), 6));
    });

    expect(entered.length).toBeGreaterThanOrEqual(MIN_OUTPUTS_IN_ONE_COMMIT);
    // One style pass and one layout for the whole band, not one for each output.
    expect(forcedPasses).toStrictEqual({ styleRecalcs: 1, layouts: 1 });
    expect(frames[0]?.cutCount).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame.cutCount > frame.showAllCount)).toStrictEqual([]);
    window.removeEventListener("error", hearResizeLoopError);
    expect(resizeLoopErrors).toStrictEqual([]);
  });
});
