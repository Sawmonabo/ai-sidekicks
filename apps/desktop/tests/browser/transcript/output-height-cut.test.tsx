// A call's output, colored or plain, is cut at a quarter of the visible flow in whole lines of its
// own type, a text size step moves the cut with the lines, and the press draws the whole output in
// place. Measured in Chromium, since the cut is CSS line units over the scroller's measured height.

import { act, cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { OUTPUT_CUT_FLOW_SHARE } from "#renderer/features/transcript/rows/bodies/hooks/useOutputHeightCut.js";
import { ToolOutput } from "#renderer/features/transcript/rows/bodies/ToolOutput.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { MarkdownWindowViewportContext } from "#renderer/features/transcript/rows/markdown/block-window/context.js";
import { FootnoteRegistry } from "#renderer/features/transcript/rows/markdown/footnotes/registry.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { DEFAULT_APPEARANCE_RECORD, TEXT_SIZES } from "#shared/appearance.js";

const SCROLLER_HEIGHT_PX = 600;
const PRINTED_LINE_COUNT = 120;
const ESCAPE = String.fromCodePoint(0x1b);
const LARGEST_TEXT_SIZE = TEXT_SIZES.reduce((largest, size) => (size > largest ? size : largest));

afterEach(() => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

/** Lets the geometry publish, the cut re-render and the observer hear the box. */
async function settleFrames(): Promise<void> {
  for (let frame = 0; frame < 4; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  }
}

/** The box's drawn content height, unrounded: its laid-out height less its edges and padding. */
function drawnContentHeightPx(box: HTMLElement): number {
  const style = getComputedStyle(box);
  const edgesPx = ["borderTopWidth", "borderBottomWidth", "paddingTop", "paddingBottom"] as const;
  return edgesPx.reduce(
    (height, edge) => height - parseFloat(style[edge]),
    box.getBoundingClientRect().height,
  );
}

/** The cut the box should stand at: the flow's share, rounded down to its whole lines. */
function expectedCutPx(box: HTMLElement): number {
  const lineHeightPx = parseFloat(getComputedStyle(box).lineHeight);
  return Math.floor((SCROLLER_HEIGHT_PX * OUTPUT_CUT_FLOW_SHARE) / lineHeightPx) * lineHeightPx;
}

/** The one element `selector` names, which the case drew. */
function drawnElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`${selector} did not mount`);
  }
  return element;
}

it("cuts a call's output at whole lines, follows the text size, opens in place", async () => {
  installMeridianTokens(document);
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  const scrollController = new ScrollController({ clock: new ManualClock() });
  const viewport = suiteWindowViewport(scrollController, {
    subscribe: () => () => undefined,
    read: () => undefined,
  });
  const holdControlInPlace = vi.fn<(control: HTMLElement) => void>();
  const coloredOutput = Array.from(
    { length: PRINTED_LINE_COUNT },
    (_line, index) => `${ESCAPE}[32mok${ESCAPE}[39m line ${String(index + 1)}`,
  ).join("\n");
  const plainOutput = Array.from(
    { length: PRINTED_LINE_COUNT },
    (_line, index) => `line ${String(index + 1)}`,
  ).join("\n");
  const { container } = render(
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
      <MarkdownWindowViewportContext value={viewport}>
        <div data-call="colored">
          <ToolOutput
            content={{ status: "available", body: coloredOutput }}
            sourceId="call-colored"
            footnotes={new FootnoteRegistry()}
            label="Output"
            holdControlInPlace={holdControlInPlace}
          />
        </div>
        <div data-call="plain">
          <ToolOutput
            content={{ status: "available", body: plainOutput }}
            sourceId="call-plain"
            footnotes={new FootnoteRegistry()}
            label="Output"
          />
        </div>
      </MarkdownWindowViewportContext>
    </div>,
  );
  await settleFrames();
  const colored = drawnElement(container, ".meridian-ansi__body");
  const plain = drawnElement(container, ".meridian-machine-body__plain");
  const fullOutputName = `Show full output (${String(PRINTED_LINE_COUNT)} lines)`;

  // The cut is in force on both: whole lines of each box's own type, the rest one press away.
  for (const box of [colored, plain]) {
    expect(drawnContentHeightPx(box)).toBeCloseTo(expectedCutPx(box), 0);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  }
  const defaultCutPx = expectedCutPx(colored);
  const coloredCall = drawnElement(container, '[data-call="colored"]');
  const control = within(coloredCall).getByRole("button", { name: fullOutputName });
  within(drawnElement(container, '[data-call="plain"]')).getByRole("button", {
    name: fullOutputName,
  });

  // A text size step moves the cut with the lines it counts.
  applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: LARGEST_TEXT_SIZE });
  await settleFrames();
  const largestCutPx = expectedCutPx(colored);
  expect(largestCutPx).not.toBeCloseTo(defaultCutPx, 0);
  expect(drawnContentHeightPx(colored)).toBeCloseTo(largestCutPx, 0);

  // The press holds its control in place and draws the whole output where it stands.
  await act(async () => {
    control.click();
    await Promise.resolve();
  });
  await settleFrames();
  expect(holdControlInPlace).toHaveBeenCalledWith(control);
  expect(colored.scrollHeight).toBe(colored.clientHeight);
  expect(within(coloredCall).queryByRole("button", { name: /^Show full output/ })).toBeNull();
});
