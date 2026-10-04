// The row's load-bearing decisions: attribution fails closed for a hue step off the wheel (a
// wrap would attribute the row to the wrong user), and a superseded row says so.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HUE_WHEEL_STEPS } from "@renderer/styles/palette.js";
import { TranscriptRowLayout } from "./TranscriptRowLayout.js";

const OCCURRED_AT = "2026-09-01T13:04:05.123Z";

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
    throw new Error("TranscriptRowLayout rendered no leading edge");
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
      {...overrides}
    />,
  );
}

describe(
  "TranscriptRowLayout — attribution fails closed rather than into " + "someone else's hue",
  () => {
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

      // The on-wheel hues are twelve distinct values, so the assertion above checks a populated
      // set.
      expect(new Set(onWheelHues).size).toBe(HUE_WHEEL_STEPS);
    });
  },
);

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
});
