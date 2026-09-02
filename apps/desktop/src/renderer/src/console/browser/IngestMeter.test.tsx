// The meter's one claim: the bar and the sentence read the same two numbers.
//
// The bar carries the value pair assistive technology reads and the sentence carries
// the pair a person reads, and the whole reason this component exists is that those
// two were composed separately in two cards and could drift apart. So the cases below
// assert them TOGETHER, against the same input, rather than either one alone.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrowserIngestMeter } from "./IngestMeter.js";

function renderMeter(receivedByteLength: number, declaredByteLength: number): HTMLElement {
  const { container } = render(
    <BrowserIngestMeter
      label="Capture ingest"
      receivedByteLength={receivedByteLength}
      declaredByteLength={declaredByteLength}
    />,
  );
  const bar = container.querySelector("[role='progressbar']");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("the meter rendered no progressbar");
  }
  return bar;
}

/** Every Unicode space as an ordinary one, so a comparison is about the words. */
function collapseUnicodeSpaces(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

describe("the browser ingest meter", () => {
  it("carries the received and declared figures on the bar itself", () => {
    const bar = renderMeter(524_288, 1_048_576);
    expect(bar.getAttribute("aria-valuenow")).toBe("524288");
    expect(bar.getAttribute("aria-valuemax")).toBe("1048576");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-label")).toBe("Capture ingest");
  });

  it("fills to the ratio of those same two figures", () => {
    expect(renderMeter(524_288, 1_048_576).firstElementChild).toHaveProperty(
      "style.inlineSize",
      "50%",
    );
  });

  it("prints the pair a person reads through the console's one byte formatter", () => {
    // Scaled by 1024 in `primitives/wire-figures.ts` and nowhere else, so the
    // sentence and the bar are two renderings of one reading rather than two
    // readings — the drift this component was extracted to prevent.
    //
    // The separators are normalized before comparing: `Intl` joins a quantity to its
    // unit with a narrow no-break space, and an expectation typed with an ordinary
    // one would fail against a correct rendering — which is a test asserting how a
    // string was typed rather than what it says.
    const bar = renderMeter(524_288, 1_048_576);
    const note = bar.parentElement?.querySelector(".meridian-browser-card__note");
    expect(collapseUnicodeSpaces(note?.textContent ?? "")).toBe("512 KiB of 1.0 MiB received.");
  });

  it("negative control: an unknown denominator is an empty bar, not a full one", () => {
    // Without this, a fill that returned "100%" whenever it could not divide would
    // satisfy every case above and would report a stalled transfer as a finished
    // one — the one reading this meter exists to make honest.
    const bar = renderMeter(524_288, 0);
    expect(bar.firstElementChild).toHaveProperty("style.inlineSize", "0%");
  });
});

// What the bar says when there is no scale to place a value on.
//
// An undeclared total is the case `ingestFillWidth` has always supported and the
// value pair never did: the fill reset to empty while `aria-valuenow` stayed at the
// received count and `aria-valuemax` took the undeclared zero, which is a position
// past the end of its own range. A progressbar with no `aria-valuenow` is
// indeterminate, which is what this is, so the numeric pair goes and the words stay.
describe("the browser ingest meter — an undeclared total", () => {
  it("omits the numeric pair rather than emitting a value past its own maximum", () => {
    const bar = renderMeter(524_288, 0);
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-valuemax")).toBeNull();
  });

  it("says what arrived and that the total is unknown, in the same words as the note", () => {
    const bar = renderMeter(524_288, 0);
    const note = bar.parentElement?.querySelector(".meridian-browser-card__note");
    expect(collapseUnicodeSpaces(bar.getAttribute("aria-valuetext") ?? "")).toBe(
      "512 KiB of an undeclared total received",
    );
    expect(collapseUnicodeSpaces(note?.textContent ?? "")).toBe(
      "512 KiB of an undeclared total received.",
    );
  });

  it("treats a denominator that is not a number the same way", () => {
    const bar = renderMeter(524_288, Number.NaN);
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-valuetext")).toContain("undeclared total");
  });

  it("negative control: a declared total still carries the numeric pair and no valuetext", () => {
    // Without this, a meter that went indeterminate unconditionally would satisfy
    // every case above and would take the scale away from every honest transfer —
    // including the one where nothing has arrived yet, which is a known range with a
    // received figure of zero rather than a range nobody declared.
    const bar = renderMeter(0, 1_048_576);
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("1048576");
    expect(bar.getAttribute("aria-valuetext")).toBeNull();
  });
});

// What the bar says when MORE arrived than was declared.
//
// A determinate range with a value past its own maximum is not a smaller kind of
// correct: `aria-valuenow` outside `[aria-valuemin, aria-valuemax]` is a position on
// a scale that cannot hold it, and the bar beside it has already been clamped to
// full, so the two readings disagreed about the one thing this component exists to
// keep together. The range is still KNOWN — the producer declared a total and the
// bytes exceeded it — so the answer is to make the numeric pair lawful and put the
// true figure in words on the same element, not to throw the scale away.
describe("the browser ingest meter — more arrived than was declared", () => {
  it("clamps the accessible value to the maximum rather than emitting a position past it", () => {
    const bar = renderMeter(4096, 1024);
    expect(bar.getAttribute("aria-valuenow")).toBe("1024");
    expect(bar.getAttribute("aria-valuemax")).toBe("1024");
    expect(bar.getAttribute("aria-valuenow")).toBe(bar.getAttribute("aria-valuemax"));
  });

  it("announces the figure that really arrived, against the total that was declared", () => {
    // The clamp is what makes the range placeable; this is what keeps it honest. The
    // words are the same ones printed under the bar, which is how the two readings
    // stay one reading.
    const bar = renderMeter(4096, 1024);
    const note = bar.parentElement?.querySelector(".meridian-browser-card__note");
    expect(collapseUnicodeSpaces(bar.getAttribute("aria-valuetext") ?? "")).toBe(
      "4.0 KiB of 1.0 KiB received",
    );
    expect(collapseUnicodeSpaces(note?.textContent ?? "")).toBe("4.0 KiB of 1.0 KiB received.");
  });

  it("keeps the scale rather than going indeterminate, and the fill stays full", () => {
    // The overrun is a declared range, so `aria-valuemax` stays: dropping it would
    // report an unknown total where the producer named one. The fill was already
    // clamped and is unchanged.
    const bar = renderMeter(4096, 1024);
    expect(bar.getAttribute("aria-valuemax")).not.toBeNull();
    expect(bar.firstElementChild).toHaveProperty("style.inlineSize", "100%");
  });

  it("negative control: an exact arrival is not an overrun and carries no valuetext", () => {
    // Without this, a meter that clamped and annotated unconditionally would satisfy
    // every case above while overriding the percentage assistive technology derives
    // for every honest transfer. Equal is the boundary, and it takes the plain pair.
    const bar = renderMeter(1024, 1024);
    expect(bar.getAttribute("aria-valuenow")).toBe("1024");
    expect(bar.getAttribute("aria-valuemax")).toBe("1024");
    expect(bar.getAttribute("aria-valuetext")).toBeNull();
  });
});
