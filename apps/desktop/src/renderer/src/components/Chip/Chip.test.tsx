// Tone set and `mono` semantics; both fail silently, so they are pinned here.

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
    // Negative control: two tones collapsed onto one class would still list four entries.
    expect(new Set(modifiers).size).toBe(CHIP_TONES.length);
  });

  it("defaults to neutral, because a chip that carries no urgency carries no color", () => {
    const chip = renderChip(<Chip label="claimed" />);
    expect(chip.classList.contains("meridian-chip--neutral")).toBe(true);
    expect(chip.classList.contains("meridian-chip--attention")).toBe(false);
  });
});

describe("Chip — `mono` marks provenance, and provenance is verbatim", () => {
  // Outer whitespace and an underscored name are what a tidying transform would destroy.
  const wireLabel = "  run.awaiting_approval  ";

  it("renders a wire label exactly as received", () => {
    const chip = renderChip(<Chip mono label={wireLabel} />);
    expect(chip.classList.contains("meridian-chip--mono")).toBe(true);
    expect(chip.textContent).toBe(wireLabel);
    // Negative control: trimming or de-underscoring would change the string.
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
    expect(chip.textContent).toBe("needs you");
  });

  it("renders no glyph when none was asked for", () => {
    expect(renderChip(<Chip label="needs you" />).querySelector("svg")).toBeNull();
  });
});
