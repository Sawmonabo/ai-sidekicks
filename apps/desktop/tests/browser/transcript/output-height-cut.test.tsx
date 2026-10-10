// A call's output, colored or plain, is cut at a quarter of the visible flow in whole lines of its
// own type, painting nothing of the line past the cut, a text size step moves the cut with the
// lines, and `Show all` draws the whole output in place. A running command's output shows its last
// whole lines and follows each new one, its rest offered under the bytes arrived so far. Measured
// in Chromium, since the cut is CSS line units over the scroller's measured height.

import { act, cleanup, render, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { OUTPUT_CUT_FLOW_SHARE } from "#renderer/features/transcript/rows/bodies/hooks/useOutputHeightCut.js";
import { type OutputOpening } from "#renderer/features/transcript/rows/bodies/OutputHeightCut.js";
import { ToolOutput } from "#renderer/features/transcript/rows/bodies/ToolOutput.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { MarkdownWindowViewportContext } from "#renderer/features/transcript/rows/markdown/block-window/context.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import {
  publishedTextOf,
  type PublishedText,
} from "#renderer/features/transcript/reveal/published-text.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";
import { settleFrames } from "./windowed/reply.js";

const SCROLLER_HEIGHT_PX = 600;
const PRINTED_LINE_COUNT = 120;
/** The lines a running command prints after it is first drawn. */
const ARRIVING_LINE_COUNT = 10;
const ESCAPE = String.fromCodePoint(0x1b);
const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

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
      sourceId="call"
      footnotes={new FootnoteRegistry()}
      label="Output"
      opening={opening}
    />
  );
}

/** The outputs drawn in a measured scroller, as a transcript's list draws them. */
function renderInScroller(children: React.ReactNode): {
  readonly container: HTMLElement;
  readonly rerender: (children: React.ReactNode) => void;
} {
  installMeridianTokens(document);
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const viewport = suiteWindowViewport(scrollController, {
    subscribe: () => () => undefined,
    read: () => undefined,
  });
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
  const rendered = render(scroller(children));
  return {
    container: rendered.container,
    rerender: (drawn) => {
      rendered.rerender(scroller(drawn));
    },
  };
}

describe("a call's output cut at the visible flow", () => {
  it("cuts at whole lines, paints none of the next, follows the text size, opens in place", async () => {
    const coloredOutput = Array.from(
      { length: PRINTED_LINE_COUNT },
      (_line, index) => `${ESCAPE}[32mok${ESCAPE}[39m line ${String(index + 1)}`,
    ).join("\n");
    const { container } = renderInScroller(
      <>
        <div data-call="colored">
          <HeldToolOutput body={coloredOutput} />
        </div>
        <div data-call="plain">
          <HeldToolOutput body={printedLines(PRINTED_LINE_COUNT)} />
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
    const { container, rerender } = renderInScroller(runningOutput(firstOutput));
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
    expect(drawnElement(container, ".meridian-full-output").textContent).toBe(
      `Show full output (${formatByteQuantity(measureUtf8ByteLength(grownOutput)).text})`,
    );
  });
});
