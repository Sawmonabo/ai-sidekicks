// The ledger row's three load-bearing decisions, pinned.
//
// Two of them are about attribution and one is about provenance, and all three fail
// in ways a screenshot would not catch:
//
//   • A hue step outside the wheel must NOT be clamped or wrapped into an occupied
//     step. Wrapping is the obvious implementation — `step % 12` is one character
//     — and it attributes a row to the wrong participant, which is worse than
//     attributing it to nobody. The row falls back to the neutral control boundary
//     and says so in its class.
//   • The edge carries the hue as a custom property rather than as a background,
//     because rule 3 forbids a participant hue behind body text.
//   • The gutter timestamp is a FORMATTED reading whose exact wire value rides the
//     element's `title` — the one shipped call site of the eight rules' "no
//     formatted figure hides the number the daemon sent".

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PARTICIPANT_HUE_STEPS, participantHueTokenName } from "../tokens/index.js";
import { RING_TREATMENTS } from "../tokens/participant-hue.js";
import { LedgerRow } from "./LedgerRow.js";
import { formatClockTime } from "./wire-figures.js";

const OCCURRED_AT = "2026-09-01T13:04:05.123Z";

function renderRow(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) {
    throw new Error("LedgerRow rendered no element");
  }
  return row;
}

function edgeOf(row: HTMLElement): HTMLElement {
  const edge = row.querySelector(".meridian-ledger-row__edge");
  if (!(edge instanceof HTMLElement)) {
    throw new Error("LedgerRow rendered no attribution edge");
  }
  return edge;
}

function basicRow(overrides: Partial<React.ComponentProps<typeof LedgerRow>> = {}): HTMLElement {
  return renderRow(
    <LedgerRow
      participantHueStep={0}
      occurredAtIso={OCCURRED_AT}
      actorLabel="Ada"
      kindLabel="assistant.message"
      {...overrides}
    />,
  );
}

describe("LedgerRow — the row is a work-log line, named by its author", () => {
  it("renders an article labelled by the actor element", () => {
    const row = basicRow();
    expect(row.tagName).toBe("ARTICLE");

    const labelledBy = row.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    const actor = row.querySelector(`#${CSS.escape(labelledBy ?? "")}`);
    expect(actor?.textContent).toBe("Ada");
  });
});

describe("LedgerRow — attribution fails closed rather than into someone else's hue", () => {
  it("carries the participant's own hue token for a step on the wheel", () => {
    const row = basicRow({ participantHueStep: 7 });
    expect(edgeOf(row).style.getPropertyValue("--meridian-row-hue")).toBe(
      `var(--meridian-${participantHueTokenName(7)})`,
    );
    expect(row.classList.contains("meridian-ledger-row--unattributed")).toBe(false);
  });

  it("refuses to wrap or clamp a step that is off the wheel", () => {
    const offWheelSteps = [PARTICIPANT_HUE_STEPS, PARTICIPANT_HUE_STEPS + 3, -1, 1.5, Number.NaN];
    const onWheelHues = Array.from({ length: PARTICIPANT_HUE_STEPS }, (_unused, step) =>
      edgeOf(basicRow({ participantHueStep: step })).style.getPropertyValue("--meridian-row-hue"),
    );

    for (const step of offWheelSteps) {
      const row = basicRow({ participantHueStep: step });
      const hue = edgeOf(row).style.getPropertyValue("--meridian-row-hue");
      expect(row.classList.contains("meridian-ledger-row--unattributed")).toBe(true);
      expect(hue).toBe("var(--meridian-edge-strong)");
      // The control that names the defect: a modulo wrap would land step 12 on
      // step 0's hue and step 15 on step 3's, and both would still render.
      expect(onWheelHues).not.toContain(hue);
    }

    // ...and the on-wheel hues really are twelve distinct values, so the assertion
    // above is checking a populated set rather than an empty one.
    expect(new Set(onWheelHues).size).toBe(PARTICIPANT_HUE_STEPS);
  });

  it("varies the edge along its length rather than its width", () => {
    // A 2 px strip has no room for a `double` border-style, so each treatment is a
    // fill pattern named on the row and drawn in `ledger-row.css`.
    for (const treatment of RING_TREATMENTS) {
      expect(
        basicRow({ ringTreatment: treatment }).classList.contains(
          `meridian-ledger-row--${treatment}`,
        ),
      ).toBe(true);
    }
    expect(basicRow().classList.contains("meridian-ledger-row--solid")).toBe(true);
  });

  it("keeps the hue off the body text by putting it only on the edge", () => {
    const row = basicRow({ participantHueStep: 3 });
    expect(row.style.getPropertyValue("--meridian-row-hue")).toBe("");
    expect(edgeOf(row).getAttribute("aria-hidden")).toBe("true");
  });
});

describe("LedgerRow — no formatted figure hides the value the daemon sent", () => {
  it("shows the clock reading and carries the exact instant in `title`", () => {
    const gutterFigure = basicRow().querySelector(".meridian-ledger-row__gutter .meridian-figure");
    expect(gutterFigure?.getAttribute("title")).toBe(OCCURRED_AT);
    expect(gutterFigure?.textContent).toBe(formatClockTime(OCCURRED_AT));
    // The control: the visible text is a READING, so it must not be the wire value
    // — if it were, the `title` would be decoration rather than the exact figure.
    expect(gutterFigure?.textContent).not.toBe(OCCURRED_AT);
  });

  it("renders the event kind mono and verbatim", () => {
    const kind = basicRow({ kindLabel: "  usage.context_compacted  " }).querySelector(
      ".meridian-ledger-row__kind .meridian-figure--wire",
    );
    expect(kind?.textContent).toBe("  usage.context_compacted  ");
  });
});

describe("LedgerRow — superseded rows and the revealed footer", () => {
  it("marks a superseded row in its class and in visible text", () => {
    const row = basicRow({ isSuperseded: true });
    expect(row.classList.contains("meridian-ledger-row--superseded")).toBe(true);
    expect(row.querySelector(".meridian-ledger-row__superseded-mark")?.textContent).toBe(
      "Superseded",
    );

    const ordinary = basicRow();
    expect(ordinary.classList.contains("meridian-ledger-row--superseded")).toBe(false);
    expect(ordinary.querySelector(".meridian-ledger-row__superseded-mark")).toBeNull();
  });

  it("renders the footer into the tree so Tab can reach it, and omits it when empty", () => {
    // Revealed by CSS on `:hover` / `:focus-within` — which only works if the
    // element is IN the tree while hidden. A footer conditionally mounted on hover
    // is unreachable by keyboard, which is the failure rule 7's reveal must avoid.
    const withFooter = basicRow({ footer: <button type="button">Edit</button> });
    expect(withFooter.querySelector(".meridian-ledger-row__footer button")?.textContent).toBe(
      "Edit",
    );
    expect(basicRow().querySelector(".meridian-ledger-row__footer")).toBeNull();
  });
});
