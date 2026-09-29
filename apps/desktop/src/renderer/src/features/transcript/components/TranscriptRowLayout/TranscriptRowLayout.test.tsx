// The transcript row's three load-bearing decisions, pinned.
//
// Two of them are about attribution and one is about provenance, and all three fail
// in ways a screenshot would not catch:
//
//   • A hue step outside the wheel must NOT be clamped or wrapped into an occupied
//     step. Wrapping is the obvious implementation — `step % 12` is one character
//     — and it attributes a row to the wrong user, which is worse than
//     attributing it to nobody. The row falls back to the neutral control boundary
//     and says so in its class.
//   • The edge carries the hue as a custom property rather than as a background,
//     because rule 3 forbids a user hue behind body text.
//   • The gutter timestamp is a FORMATTED reading whose exact wire value rides the
//     element's `title` — the one shipped call site of the eight rules' "no
//     formatted figure hides the number the daemon sent".
//
// And one cost claim, checked the only way a cost claim can be: by counting calls.
// `formatClockTime` builds a fresh `Intl.DateTimeFormat` per call, and this row is
// what every transcript surface in the console is made of, so the gutter reading is
// memoized on the instant. The suite spies the real formatter rather than a stand-in
// — `{ spy: true }` keeps the implementation, so every other case here still reads
// the true string.

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
      // The control that names the defect: a modulo wrap would land step 12 on
      // step 0's hue and step 15 on step 3's, and both would still render.
      expect(onWheelHues).not.toContain(hue);
    }

    // ...and the on-wheel hues really are twelve distinct values, so the assertion
    // above is checking a populated set rather than an empty one.
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
    // The control: the visible text is a READING, so it must not be the wire value
    // — if it were, the `title` would be decoration rather than the exact figure.
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

    // Two more paints of the SAME row, each moving something a streaming window
    // moves — a kind label here stands for a lease write, a hover, a reveal tick —
    // and none of them moving the instant the row is stamped with.
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
    // The control that the re-renders were real: the row's own text moved.
    expect(container.querySelector(".meridian-transcript-row-layout__kind")?.textContent).toBe(
      "tool.result",
    );
    expect(formatter).toHaveBeenCalledTimes(1);

    // ...and the memo is keyed on the instant rather than frozen at mount, so a row
    // whose instant moves is re-read rather than showing the moment before it.
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
    // Revealed by CSS on `:hover` / `:focus-within` — which only works if the
    // element is IN the tree while hidden. A footer conditionally mounted on hover
    // is unreachable by keyboard, which is the failure rule 7's reveal must avoid.
    const withFooter = basicRow({ footer: <button type="button">Edit</button> });
    expect(
      withFooter.querySelector(".meridian-transcript-row-layout__footer button")?.textContent,
    ).toBe("Edit");
    expect(basicRow().querySelector(".meridian-transcript-row-layout__footer")).toBeNull();
  });
});
