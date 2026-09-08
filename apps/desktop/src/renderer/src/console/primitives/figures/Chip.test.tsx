// The chip's two closed decisions: which tones exist, and what `mono` means.
//
// Both are pinned here because both fail SILENTLY. A fifth tone added to the union
// renders a class the stylesheet has no rule for, so the chip looks neutral and the
// two-hue rule dies without a single test going red. A `mono` chip whose label got
// trimmed or title-cased still renders — it just no longer says what the daemon
// said, which is the failure `formatWireString` exists to make impossible.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CHIP_TONES, Chip } from "./Chip.js";

/** The chip element itself, not the harness container it was mounted into. */
function renderChip(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const chip = container.firstElementChild;
  if (!(chip instanceof HTMLElement)) {
    throw new Error("Chip rendered no element");
  }
  return chip;
}

describe("Chip — the tone set is closed and each tone is spent once", () => {
  it("gives every tone in the set its own modifier class", () => {
    const modifiers = CHIP_TONES.map(
      (tone) =>
        [...renderChip(<Chip tone={tone} label="one fact" />).classList].find((className) =>
          className.startsWith("meridian-chip--"),
        ) ?? "",
    );

    expect(modifiers).toStrictEqual([
      "meridian-chip--neutral",
      "meridian-chip--attention",
      "meridian-chip--failure",
      "meridian-chip--accent",
    ]);
    // The negative control for the assertion above: if two tones ever collapsed
    // onto one class — the shape rule 3's "at most one colour" fails as — the
    // literal list would still be four entries long but would not be four
    // DISTINCT entries.
    expect(new Set(modifiers).size).toBe(CHIP_TONES.length);
  });

  it("defaults to neutral, because a chip that carries no urgency carries no colour", () => {
    const chip = renderChip(<Chip label="claimed" />);
    expect(chip.classList.contains("meridian-chip--neutral")).toBe(true);
    expect(chip.classList.contains("meridian-chip--attention")).toBe(false);
  });
});

describe("Chip — `mono` marks provenance, and provenance is verbatim", () => {
  // A real wire string with the properties a "tidying" transform would destroy:
  // outer whitespace and an underscored machine name.
  const wireLabel = "  run.awaiting_approval  ";

  it("renders a wire label exactly as received", () => {
    const chip = renderChip(<Chip mono label={wireLabel} />);
    expect(chip.classList.contains("meridian-chip--mono")).toBe(true);
    expect(chip.textContent).toBe(wireLabel);
    // Negative control: the two most plausible "improvements" both produce a
    // different string, so the assertion above is not passing vacuously.
    expect(chip.textContent).not.toBe(wireLabel.trim());
    expect(chip.textContent).not.toBe(wireLabel.replaceAll("_", " "));
  });

  it("leaves the mono class off a label the console composed", () => {
    const chip = renderChip(<Chip label="three rows collapsed" />);
    expect(chip.classList.contains("meridian-chip--mono")).toBe(false);
  });
});

describe("Chip — the glyph is decoration and the label carries the meaning", () => {
  it("hides the glyph from assistive technology", () => {
    const chip = renderChip(<Chip glyph="alert" label="needs you" tone="attention" />);
    const glyph = chip.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    // The label is the accessible content, so the chip still reads as its fact.
    expect(chip.textContent).toBe("needs you");
  });

  it("renders no glyph when none was asked for", () => {
    expect(renderChip(<Chip label="needs you" />).querySelector("svg")).toBeNull();
  });
});
