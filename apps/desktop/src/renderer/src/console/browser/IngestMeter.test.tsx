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
    expect(bar.getAttribute("aria-valuenow")).toBe("524288");
  });
});
