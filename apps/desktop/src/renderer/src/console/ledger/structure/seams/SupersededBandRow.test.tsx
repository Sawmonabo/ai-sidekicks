// The band header, held to the two things it exists to say.
//
// Every case reads the RENDERED line, because the defect this row answers was a band
// that was derived in full and drawn as nothing but a dim on each of its rows: a case
// over `deriveSupersededBands` would have passed against a console that showed no
// header at all.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SupersededBandRow } from "./SupersededBandRow.js";
import { type SupersededBand } from "./superseded-bands.js";

function band(overrides: Partial<SupersededBand> = {}): SupersededBand {
  return { runId: "run-a", epoch: 0, targetPosition: 12, rowIds: ["a13", "a14"], ...overrides };
}

function renderBand(
  subject: SupersededBand,
  isFolded = false,
  onToggle: (band: SupersededBand) => void = () => undefined,
): HTMLElement {
  const { container } = render(
    <SupersededBandRow band={subject} isFolded={isFolded} onToggle={onToggle} />,
  );
  const line = container.querySelector<HTMLElement>(".meridian-superseded-band");
  if (line === null) {
    throw new Error("the band header drew no line");
  }
  return line;
}

describe("the superseded band header — the turn a rewind landed on", () => {
  it("names the cutoff verbatim", () => {
    const line = renderBand(band());
    expect(line.textContent).toContain("Superseded at turn");
    expect(line.textContent).toContain("12");
  });

  it("says how many entries the rewind moved", () => {
    expect(renderBand(band()).textContent).toContain("2 entries");
    expect(renderBand(band({ rowIds: ["a13"] })).textContent).toContain("1 entry");
  });
});

describe("the fold control — one act, offered over rows that are already on screen", () => {
  it("reports the band open, because that is what a band starts as", () => {
    const control = renderBand(band()).querySelector<HTMLButtonElement>(
      ".meridian-superseded-band__disclosure",
    );
    expect(control?.getAttribute("aria-expanded")).toBe("true");
    expect(control?.textContent).toContain("Fold");
  });

  it("offers the way back once a band is folded", () => {
    const control = renderBand(band(), true).querySelector<HTMLButtonElement>(
      ".meridian-superseded-band__disclosure",
    );
    expect(control?.getAttribute("aria-expanded")).toBe("false");
    expect(control?.textContent).toContain("Show");
  });

  it("hands the band back rather than a key the caller has to re-derive", () => {
    const onToggle = vi.fn();
    const subject = band();
    renderBand(subject, false, onToggle)
      .querySelector<HTMLButtonElement>(".meridian-superseded-band__disclosure")
      ?.click();
    expect(onToggle).toHaveBeenCalledWith(subject);
  });
});
