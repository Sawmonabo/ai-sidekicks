// A long command output drawn as a window over its chunks of lines in a scroller, as the transcript
// draws it, in the engine that lays it out: a selection dragged from one line to another far past
// the window copies every line between from the output's chunks, assistive technology is told the
// output's name and reads its drawn lines as the output holds them, never a spacer, the output's
// whole height is laid out, its undrawn lines measured off screen, before any scroll, and an output
// that sets a style again and again and never resets it mounts in heap that grows with its text
// alone. A long plain output, a tool's result with no escape, is drawn through the same window.

import { act, render, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { readSelectedPart } from "#renderer/features/transcript/copy/conversation-selection.js";
import { AnsiOutput } from "#renderer/features/transcript/rows/ansi/AnsiOutput.js";
import {
  ANSI_LINE_CHUNK_INDEX_ATTRIBUTE,
  ANSI_OUTPUT_KEY_ATTRIBUTE,
} from "#renderer/features/transcript/rows/ansi/lines/markers.js";
import {
  PreparedBodiesContext,
  type PreparedBodies,
} from "#renderer/features/transcript/rows/prepared-bodies.js";
import { prepareOutputForTest } from "#renderer/features/transcript/rows/ansi/preparation.test-support.js";
import { ToolOutput } from "#renderer/features/transcript/rows/bodies/ToolOutput.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import { prepareRowBodiesForTest } from "#renderer/features/transcript/rows/preparation.test-support.js";
import {
  SuiteWindowViewportProvider,
  suiteWindowViewport,
} from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import {
  DrawnWindowSources,
  DrawnWindowSourcesContext,
} from "#renderer/features/transcript/rows/drawn-window-sources.js";
import { ViewportSelectionTracker } from "#renderer/features/transcript/viewport/selection/tracker.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
import { SCROLLER_HEIGHT_PX, settleFrames } from "./reply.js";

const ESCAPE = String.fromCodePoint(0x1b);
const ROW_KEY = "output";
const LABEL = "Output of build";
/** Lines enough for the window to draw a few of its chunks out of many. */
const LINE_COUNT = 4_000;
/** A plain output's lines, far more than any view draws. */
const PLAIN_LINE_COUNT = 50_000;

/**
 * The output's lines as a reader sees them, each named for its place, every tenth long, of words
 * so long that a row holds few, so its lines wrap at their words onto more rows than their length
 * alone fills.
 */
const LINES = Array.from({ length: LINE_COUNT }, (_, index) => {
  const name = `L${String(index).padStart(5, "0")}:`;
  return index % 10 === 0 ? `${name} ${`${"wrapping".repeat(4)}words `.repeat(8)}` : `${name} done`;
});

/** The output as a program printed it: each line in a color of its own, a style left open. */
const OUTPUT = LINES.map(
  (line, index) =>
    `${ESCAPE}[3${String(index % 8)}m${index % 7 === 0 ? `${ESCAPE}[1m` : ""}${line}`,
).join("\n");

/** A mounted output: its scroller, its row, and the sources a copy reads undrawn lines from. */
interface MountedOutput {
  readonly scroller: HTMLElement;
  readonly row: HTMLElement;
  readonly sources: DrawnWindowSources;
}

/**
 * Draws `output`, the suite's own unless given, in a scroller inside a viewport, as the transcript
 * draws a tool's row.
 */
async function mountOutput(output: string = OUTPUT): Promise<MountedOutput> {
  // Parsed whole before it mounts, as the feed lists a row only once its output is.
  const prepared = prepareOutputForTest(ROW_KEY, output);
  onTestFinished(() => {
    prepared.release();
  });
  await prepared.whole;
  return mountInRow(
    prepared.outputs,
    <AnsiOutput className="meridian-ansi__body" label={LABEL} rowKey={ROW_KEY} />,
  );
}

/** Draws `body` in the suite's row, in a scroller inside a viewport, drawing from `bodies`. */
async function mountInRow(bodies: PreparedBodies, body: React.ReactNode): Promise<MountedOutput> {
  installMeridianTokens(document);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const tracker = new ViewportSelectionTracker({
    holdSelectedRows: () => {},
    logPositionOf: (rowKey) => (rowKey === ROW_KEY ? 0 : undefined),
    drawRow: () => {},
  });
  const viewport = suiteWindowViewport(scrollController, {
    subscribe: (listener) => tracker.subscribe(listener),
    read: () => tracker.selectionRange,
  });
  const sources = new DrawnWindowSources();
  const view = render(
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
        width: "680px",
        height: `${String(SCROLLER_HEIGHT_PX)}px`,
        overflowY: "scroll",
        overflowAnchor: "none",
      }}
    >
      <div
        data-testid="row"
        {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: 0 }}
        ref={(element) => {
          if (element !== null) {
            tracker.addRow(element, ROW_KEY);
          }
        }}
        style={{ width: "600px" }}
      >
        <SuiteWindowViewportProvider viewport={viewport}>
          <PreparedBodiesContext value={bodies}>
            <DrawnWindowSourcesContext value={sources}>{body}</DrawnWindowSourcesContext>
          </PreparedBodiesContext>
        </SuiteWindowViewportProvider>
      </div>
    </div>,
  );
  onTestFinished(() => {
    view.unmount();
  });
  await settleFrames();
  const scroller = view.getByTestId("scroller");
  return { scroller, row: view.getByTestId("row"), sources };
}

/** The text node and offset where line `index` begins in the drawn output; throws if undrawn. */
function lineStart(
  row: HTMLElement,
  index: number,
): { readonly node: Text; readonly offset: number } {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const name = LINES[index]?.slice(0, 7) ?? "";
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const offset = (node as Text).data.indexOf(name);
    if (offset !== -1) {
      return { node: node as Text, offset };
    }
  }
  throw new Error(`line ${String(index)} is not drawn`);
}

/** Scrolls until line `index` is drawn, and answers where it begins. */
async function scrollToLine(
  scroller: HTMLElement,
  row: HTMLElement,
  index: number,
): Promise<{ readonly node: Text; readonly offset: number }> {
  scroller.scrollTop = (scroller.scrollHeight * index) / LINE_COUNT;
  await settleFrames();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const drawn = [...row.querySelectorAll(`[${ANSI_LINE_CHUNK_INDEX_ATTRIBUTE}]`)].map(
      (chunk) => chunk.textContent,
    );
    const name = LINES[index]?.slice(0, 7) ?? "";
    const first = drawn[0]?.slice(0, 7) ?? "";
    if (drawn.some((text) => text.includes(name))) {
      return lineStart(row, index);
    }
    // The window's estimates move as it measures: step toward the line.
    scroller.scrollTop += first > name ? -SCROLLER_HEIGHT_PX : SCROLLER_HEIGHT_PX;
    await settleFrames();
  }
  throw new Error(`line ${String(index)} never drew`);
}

/**
 * The page's heap in use after a full collection. The browser tiers run Chromium with `gc()`
 * exposed and `performance.memory` precise, so the reading is exact and taken now.
 */
function collectedHeapBytes(): number {
  const { gc } = globalThis as { gc?: () => void };
  const { memory } = performance as { memory?: { readonly usedJSHeapSize: number } };
  if (gc === undefined || memory === undefined) {
    return expect.fail("the page cannot collect its garbage and read its heap");
  }
  gc();
  return memory.usedJSHeapSize;
}

/**
 * Eight mebibytes of the suite's colored lines, numbered on past its own: every seventh sets bold
 * again and none resets it, so one style stays open the whole way, set over and over.
 */
function eightMebibytesWithStyleLeftOpen(): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < 8 * 1_048_576; index += 1) {
    const line =
      `${ESCAPE}[3${String(index % 8)}m${index % 7 === 0 ? `${ESCAPE}[1m` : ""}` +
      `L${String(index).padStart(6, "0")}: done`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * The most heap a mounted output may keep for each character of its text: a few dozen bytes hold
 * a character in its spans and chunks, where a style list copied into every run the style spans
 * would take gigabytes.
 */
const KEPT_HEAP_BYTES_PER_CHARACTER = 32;

/** Waits until no chunk has stood in the measuring frames for a few frames running. */
async function settleMeasuring(): Promise<void> {
  for (let quietRounds = 0, round = 0; quietRounds < 3; round += 1) {
    if (round > 200) {
      expect.fail("the output's chunks never finished measuring off screen");
    }
    await settleFrames();
    quietRounds =
      document.querySelector(".meridian-measuring-frames .meridian-ansi__chunk") === null
        ? quietRounds + 1
        : 0;
  }
}

describe("browser — a long command output drawn as a window over its lines", () => {
  it("mounts 8 MiB that never resets a style it sets again and again in heap that grows with its text", async () => {
    const output = eightMebibytesWithStyleLeftOpen();
    const heapBeforeBytes = collectedHeapBytes();
    const { row } = await mountOutput(output);
    const keptHeapBytes = collectedHeapBytes() - heapBeforeBytes;
    // The style is still open at the top: the first line set bold is drawn bold.
    expect(row.querySelector(".meridian-ansi--bold")?.textContent).toBe("L000000: done\n");
    expect(keptHeapBytes).toBeLessThan(KEPT_HEAP_BYTES_PER_CHARACTER * output.length);
  });

  it("lays out the whole output's height before any scroll, its undrawn lines measured off screen", async () => {
    const { scroller, row } = await mountOutput();
    // The same output drawn whole, at the same width, outside any window.
    const prepared = prepareOutputForTest("whole", OUTPUT);
    await prepared.whole;
    const whole = render(
      <div style={{ width: "600px" }}>
        <PreparedBodiesContext value={prepared.outputs}>
          <AnsiOutput className="meridian-ansi__body" label={LABEL} rowKey="whole" />
        </PreparedBodiesContext>
      </div>,
    );
    onTestFinished(() => {
      whole.unmount();
      prepared.release();
    });
    await settleMeasuring();

    expect(scroller.scrollTop).toBe(0);
    expect(row.querySelectorAll(`[${ANSI_OUTPUT_KEY_ATTRIBUTE}]`).length).toBeGreaterThan(0);
    const heightOf = (root: Element): number =>
      (
        root.querySelector(".meridian-ansi__lines") ?? expect.fail("the output's lines")
      ).getBoundingClientRect().height;
    expect(heightOf(row)).toBeCloseTo(heightOf(whole.container), 0);
  });

  it("copies a selection dragged far past the window in full, its undrawn lines from the output's chunks", async () => {
    const { scroller, row, sources } = await mountOutput();
    const selection = document.getSelection() ?? expect.fail("the document has a selection");
    const firstLine = 12;
    const lastLine = 3_517;
    const start = await scrollToLine(scroller, row, firstLine);
    // A press: a caret, which the window keeps drawn while the reader scrolls to the far end.
    act(() => {
      selection.collapse(start.node, start.offset);
    });
    await settleFrames();
    const end = await scrollToLine(scroller, row, lastLine);
    const lastLineLength = LINES[lastLine]?.length ?? 0;
    act(() => {
      selection.extend(end.node, end.offset + lastLineLength);
    });
    await settleFrames();

    const range = selection.getRangeAt(0);
    const spacers = [...row.querySelectorAll(`[${ANSI_OUTPUT_KEY_ATTRIBUTE}]`)];
    // Most lines between the ends are not drawn: spacers stand for them inside the selection.
    expect(spacers.some((spacer) => range.intersectsNode(spacer))).toBe(true);
    const { text } = await readSelectedPart(
      range,
      row,
      () => expect.fail("the output draws no large body"),
      markdownWorker,
      (sourceKey) => sources.sourceOf(sourceKey),
    );
    selection.removeAllRanges();
    expect(text).toBe(LINES.slice(firstLine, lastLine + 1).join("\n"));
  });

  it("tells assistive technology the output's name, and reads its drawn lines as the output's own", async () => {
    const { scroller, row } = await mountOutput();
    for (const line of [0, 1_900, LINE_COUNT - 1]) {
      await scrollToLine(scroller, row, line);
      const box = within(row).getByLabelText(LABEL);
      expect(box.tagName).toBe("PRE");
      const chunks = [...box.querySelectorAll(`[${ANSI_LINE_CHUNK_INDEX_ATTRIBUTE}]`)];
      const spacers = [...box.querySelectorAll(`[${ANSI_OUTPUT_KEY_ATTRIBUTE}]`)];
      expect(chunks.length).toBeGreaterThan(0);
      expect(spacers.length).toBeGreaterThan(0);
      // A spacer is hidden from assistive technology and holds no text to read.
      for (const spacer of spacers) {
        expect(spacer.getAttribute("aria-hidden")).toBe("true");
        expect(spacer.textContent).toBe("");
      }
      // The drawn lines read in order as one run of the output's lines.
      const drawnText = chunks.map((chunk) => chunk.textContent).join("");
      const firstDrawn = LINES.findIndex((output) => drawnText.startsWith(output));
      const drawnLines = drawnText.replace(/\n$/u, "").split("\n");
      expect(drawnLines).toEqual(LINES.slice(firstDrawn, firstDrawn + drawnLines.length));
    }
  });

  it("draws only the lines near the view of a 50,000-line plain output, the rest held at their own height", async () => {
    const printed = Array.from(
      { length: PLAIN_LINE_COUNT },
      (_, index) => `P${String(index).padStart(5, "0")}: printed`,
    );
    const body = printed.join("\n");
    const toolRow = sampleRunRow({
      id: ROW_KEY,
      type: "tool.result",
      content: { status: "available", body },
    });
    const { row } = await mountInRow(
      prepareRowBodiesForTest([toolRow]).bodies,
      // The type a transcript row's body sets, which a plain output inherits.
      <div
        style={{
          fontSize: "var(--meridian-text-sm)",
          lineHeight: "var(--meridian-reading-line-height)",
        }}
      >
        <ToolOutput
          content={{ status: "available", body }}
          sourceId={ROW_KEY}
          footnotes={new FootnoteRegistry()}
          label={LABEL}
        />
      </div>,
    );
    await settleMeasuring();
    const box = row.querySelector(".meridian-machine-body__plain") ?? expect.fail("a plain box");
    const drawnLines = (box.textContent ?? "").split("\n").filter((line) => line !== "");

    // The first lines, where the reader stands, are drawn as printed; the far ones are not.
    expect(drawnLines.slice(0, 3)).toStrictEqual(printed.slice(0, 3));
    expect(drawnLines.length).toBeLessThan(PLAIN_LINE_COUNT / 20);
    expect(box.textContent).not.toContain(printed.at(-1));
    // Every undrawn line is held at the height a drawn one stands at, none of these lines wrapping.
    const firstChunk =
      box.querySelector(`[${ANSI_LINE_CHUNK_INDEX_ATTRIBUTE}="0"]`) ?? expect.fail("a drawn chunk");
    const firstChunkLineCount = (firstChunk.textContent ?? "").split("\n").length - 1;
    const linePitchPx = firstChunk.getBoundingClientRect().height / firstChunkLineCount;
    const lines = box.querySelector(".meridian-ansi__lines") ?? expect.fail("the output's lines");
    expect(lines.getBoundingClientRect().height).toBeCloseTo(PLAIN_LINE_COUNT * linePitchPx, 0);
  });
});
