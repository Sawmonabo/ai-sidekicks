// The shared lane reading: "the lane said nothing" must differ from "there is no lane".
//
// Suites assert `toBe("")` often, so a missing announcer must not read as silence. It uses plain
// DOM, not a rendered `LiveRegion`: mounting the writer would make the missing-region control
// unreachable.

import { describe, expect, it } from "vitest";

import { liveRegionOf, liveRegionText, politeText, regionsOf } from "./live-region.js";

/** A window that mounted the pair, saying whatever the caller passes. */
function containerWithRegions(polite: string, assertive: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML =
    `<div data-live-region="polite">${polite}</div>` +
    `<div data-live-region="assertive">${assertive}</div>`;
  return container;
}

describe("live region test support — reading one lane", () => {
  it("reads the polite lane", () => {
    expect(politeText(containerWithRegions("Saved.", "Refused."))).toBe("Saved.");
  });

  it("reads each lane separately", () => {
    // Without this `politeText` could read whichever region comes first and pass the case above.
    const container = containerWithRegions("Saved.", "Refused.");
    expect(liveRegionText(container, "polite")).toBe("Saved.");
    expect(liveRegionText(container, "assertive")).toBe("Refused.");
  });

  it("reads an empty lane as silence", () => {
    expect(politeText(containerWithRegions("", "Refused."))).toBe("");
  });

  it("negative control: a container with no lane throws rather than reading as silence", () => {
    // A window that mounted no announcer must not answer what a silent announcer answers.
    const empty = document.createElement("div");
    expect(() => politeText(empty)).toThrowError(/no polite live region/);
    expect(() => liveRegionText(empty, "assertive")).toThrowError(/no assertive live region/);
    expect(() => liveRegionOf(empty, "polite")).toThrowError(/no polite live region/);
  });

  it("negative control: one lane present is not both", () => {
    // A pair-count assertion would pass on one region twice; this holds the two readings against
    // each other on a half-mounted container.
    const container = document.createElement("div");
    container.innerHTML = `<div data-live-region="polite">Saved.</div>`;
    expect(regionsOf(container)).toHaveLength(1);
    expect(politeText(container)).toBe("Saved.");
    expect(() => liveRegionText(container, "assertive")).toThrowError(/no assertive/);
  });
});
