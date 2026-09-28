// The rail's attachment strip.
//
// Mounted through the shared rail harness rather than against the components directly,
// because the claims here are about composition — that a drop reaches the carrier the
// rail opened and lands on the strip the rail renders.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { eventCarrying, fileTransferOf } from "./attachments/attachment-input.test-support.js";
import { mountRail, railRegion } from "./rail.test-support.js";

describe("the composer's attachment strip", () => {
  it("is absent while the message carries nothing", () => {
    const container = mountRail([]);
    expect(container.querySelector(".meridian-composer-attachments")).toBeNull();
  });

  it("puts a dropped file on the strip under the name it was declared with", async () => {
    const container = mountRail([]);
    const region = railRegion(container);
    const dropped = new File(["payload"], "notes.md", { type: "text/plain" });
    const event = eventCarrying("drop", "dataTransfer", fileTransferOf([dropped]));
    await act(async () => {
      region.dispatchEvent(event);
    });
    const strip = container.querySelector(".meridian-composer-attachments");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("notes.md");
    // The running count against the bound, which is a figure and never a gate.
    expect(strip?.textContent).toContain("of 10 attached");
  });

  it("carries its name on an element that can hold one", async () => {
    // The strip was a `div` with an `aria-label`, and a `div` is `generic`: naming a
    // generic element names nothing, so the label reached no assistive technology at
    // all. A landmark takes it — and the strip is one, a standing region beside the
    // message line rather than decoration inside it. (The accessibility tier cannot
    // stand in for this case: `aria-prohibited-attr` is outside the WCAG A/AA tag set
    // that tier runs, measured 2026-09-09 against a planted `div aria-label`.)
    const container = mountRail([]);
    const region = railRegion(container);
    const event = eventCarrying(
      "drop",
      "dataTransfer",
      fileTransferOf([new File(["payload"], "notes.md", { type: "text/plain" })]),
    );
    await act(async () => {
      region.dispatchEvent(event);
    });
    const strip = container.querySelector(".meridian-composer-attachments");

    expect(strip?.tagName).toBe("SECTION");
    expect(strip?.getAttribute("aria-label")).toBe("Attachments on this message");
  });
});
