// The row's load-bearing decisions: attribution fails closed for a hue step off the wheel (a
// wrap would attribute the row to the wrong user), the hue sits only on the edge, the gutter
// keeps the exact wire instant in `title`, and each instant is formatted once. The suite spies
// the real formatter (`{ spy: true }`), so every other case still reads the true string.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HUE_WHEEL_STEPS } from "@renderer/styles/palette.js";
import { formatHueWheelTokenName } from "@renderer/styles/tokens.js";
import { TranscriptRowLayout } from "./TranscriptRowLayout.js";
import { formatClockTime } from "@renderer/lib/wire-figures.js";

vi.mock(import("@renderer/lib/wire-figures.js"), { spy: true });

const OCCURRED_AT = "2026-09-01T13:04:05.123Z";
const LATER_INSTANT = "2026-09-01T13:04:09.456Z";

function renderRow(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) {
    throw new Error("TranscriptRowLayout rendered no element");
  }
  return row;
}

function edgeOf(row: HTMLElement): HTMLElement {
  const edge = row.querySelector(".meridian-transcript-row-layout__edge");
  if (!(edge instanceof HTMLElement)) {
    throw new Error("TranscriptRowLayout rendered no attribution edge");
  }
  return edge;
}

function basicRow(
  overrides: Partial<React.ComponentProps<typeof TranscriptRowLayout>> = {},
): HTMLElement {
  return renderRow(
    <TranscriptRowLayout
      agentHueStep={0}
      occurredAtIso={OCCURRED_AT}
      authorLabel="Ada"
      kindLabel="assistant.message"
      {...overrides}
    />,
  );
}

describe("TranscriptRowLayout — the row is a work-log line, named by its author", () => {
  it("renders an article labeled by the actor element", () => {
    const row = basicRow();
    expect(row.tagName).toBe("ARTICLE");

    const labelledBy = row.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    const actor = row.querySelector(`#${CSS.escape(labelledBy ?? "")}`);
    expect(actor?.textContent).toBe("Ada");
  });
});

describe("TranscriptRowLayout — attribution fails closed rather than into someone else's hue", () => {
  it("carries the user's own hue token for a step on the wheel", () => {
    const row = basicRow({ agentHueStep: 7 });
    expect(edgeOf(row).style.getPropertyValue("--meridian-row-hue")).toBe(
      `var(--meridian-${formatHueWheelTokenName(7)})`,
    );
    expect(row.classList.contains("meridian-transcript-row-layout--unattributed")).toBe(false);
  });

  it("refuses to wrap or clamp a step that is off the wheel", () => {
    const offWheelSteps = [HUE_WHEEL_STEPS, HUE_WHEEL_STEPS + 3, -1, 1.5, Number.NaN];
    const onWheelHues = Array.from({ length: HUE_WHEEL_STEPS }, (_unused, step) =>
      edgeOf(basicRow({ agentHueStep: step })).style.getPropertyValue("--meridian-row-hue"),
    );

    for (const step of offWheelSteps) {
      const row = basicRow({ agentHueStep: step });
      const hue = edgeOf(row).style.getPropertyValue("--meridian-row-hue");
      expect(row.classList.contains("meridian-transcript-row-layout--unattributed")).toBe(true);
      expect(hue).toBe("var(--meridian-edge-strong)");
      // A modulo wrap would land step 12 on step 0's hue and step 15 on step 3's.
      expect(onWheelHues).not.toContain(hue);
    }

    // The on-wheel hues are twelve distinct values, so the assertion above checks a populated set.
    expect(new Set(onWheelHues).size).toBe(HUE_WHEEL_STEPS);
  });

  it("keeps the hue off the body text by putting it only on the edge", () => {
    const row = basicRow({ agentHueStep: 3 });
    expect(row.style.getPropertyValue("--meridian-row-hue")).toBe("");
    expect(edgeOf(row).getAttribute("aria-hidden")).toBe("true");
  });
});

describe("TranscriptRowLayout — no formatted figure hides the value the daemon sent", () => {
  it("shows the clock reading and carries the exact instant in `title`", () => {
    const gutterFigure = basicRow().querySelector(
      ".meridian-transcript-row-layout__gutter .meridian-figure",
    );
    expect(gutterFigure?.getAttribute("title")).toBe(OCCURRED_AT);
    expect(gutterFigure?.textContent).toBe(formatClockTime(OCCURRED_AT));
    // The visible text is a reading, not the wire value; otherwise `title` would be decoration.
    expect(gutterFigure?.textContent).not.toBe(OCCURRED_AT);
  });

  it("formats one instant once, however many times the row repaints", () => {
    const formatter = vi.mocked(formatClockTime);
    formatter.mockClear();

    const { rerender, container } = render(
      <TranscriptRowLayout
        agentHueStep={0}
        occurredAtIso={OCCURRED_AT}
        authorLabel="Ada"
        kindLabel="assistant.message"
      />,
    );
    expect(formatter).toHaveBeenCalledTimes(1);

    // Repaints that never move the instant, as a lease write, hover or reveal tick would not.
    for (const kindLabel of ["tool.invoked", "tool.result"]) {
      rerender(
        <TranscriptRowLayout
          agentHueStep={0}
          occurredAtIso={OCCURRED_AT}
          authorLabel="Ada"
          kindLabel={kindLabel}
        />,
      );
    }
    // Confirms the re-renders were real.
    expect(container.querySelector(".meridian-transcript-row-layout__kind")?.textContent).toBe(
      "tool.result",
    );
    expect(formatter).toHaveBeenCalledTimes(1);

    // The memo is keyed on the instant, so a row whose instant moves is re-read.
    rerender(
      <TranscriptRowLayout
        agentHueStep={0}
        occurredAtIso={LATER_INSTANT}
        authorLabel="Ada"
        kindLabel="tool.result"
      />,
    );
    expect(formatter).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector(".meridian-transcript-row-layout__gutter .meridian-figure")
        ?.textContent,
    ).toBe(formatter.mock.results[1]?.value);
  });

  it("renders the event kind mono and verbatim", () => {
    const kind = basicRow({ kindLabel: "  usage.context_compacted  " }).querySelector(
      ".meridian-transcript-row-layout__kind .meridian-figure--wire",
    );
    expect(kind?.textContent).toBe("  usage.context_compacted  ");
  });
});

describe("TranscriptRowLayout — superseded rows and the revealed footer", () => {
  it("marks a superseded row in its class and in visible text", () => {
    const row = basicRow({ isSuperseded: true });
    expect(row.classList.contains("meridian-transcript-row-layout--superseded")).toBe(true);
    expect(row.querySelector(".meridian-transcript-row-layout__superseded-mark")?.textContent).toBe(
      "Superseded",
    );

    const ordinary = basicRow();
    expect(ordinary.classList.contains("meridian-transcript-row-layout--superseded")).toBe(false);
    expect(ordinary.querySelector(".meridian-transcript-row-layout__superseded-mark")).toBeNull();
  });

  it("renders the footer into the tree so Tab can reach it, and omits it when empty", () => {
    // Revealed by CSS on `:hover` / `:focus-within`, so the element must be in the tree while
    // hidden; a footer mounted on hover is unreachable by keyboard.
    const withFooter = basicRow({ footer: <button type="button">Edit</button> });
    expect(
      withFooter.querySelector(".meridian-transcript-row-layout__footer button")?.textContent,
    ).toBe("Edit");
    expect(basicRow().querySelector(".meridian-transcript-row-layout__footer")).toBeNull();
  });
});
