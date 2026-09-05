// The lane reading every announcer suite now shares.
//
// A `.test-support` module is a module like any other (`apps/desktop/AGENTS.md`), and
// this one is read by four suites whose assertions are mostly `toBe("")` — so the
// difference between "the lane said nothing" and "there is no lane" is the whole
// reason it exists and is what the controls below hold.
//
// Plain DOM rather than a rendered `LiveRegion`: the claim is about a query over an
// attribute, and mounting the component that writes the attribute would make the
// missing-region control unreachable — there would be no way to build the container
// this module has to refuse.

import { describe, expect, it } from "vitest";

import { liveRegionOf, liveRegionText, politeText, regionsOf } from "./live-region.test-support.js";

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
    // Without this `politeText` could be reading whichever region comes first in the
    // document and would pass the case above on every container this suite builds.
    const container = containerWithRegions("Saved.", "Refused.");
    expect(liveRegionText(container, "polite")).toBe("Saved.");
    expect(liveRegionText(container, "assertive")).toBe("Refused.");
  });

  it("reads an empty lane as silence", () => {
    expect(politeText(containerWithRegions("", "Refused."))).toBe("");
  });

  it("negative control: a container with no lane throws rather than reading as silence", () => {
    // The state the two `?? ""` copies this module replaced could not report: a
    // window that mounted no announcer answered exactly what a window whose announcer
    // had nothing to say answers, and every suite here asserts `""` somewhere.
    const empty = document.createElement("div");
    expect(() => politeText(empty)).toThrowError(/no polite live region/);
    expect(() => liveRegionText(empty, "assertive")).toThrowError(/no assertive live region/);
    expect(() => liveRegionOf(empty, "polite")).toThrowError(/no polite live region/);
  });

  it("negative control: one lane present is not both", () => {
    // A pair-count assertion elsewhere would pass on a container holding one region
    // twice; this holds the two readings against each other on a container that
    // really is half-mounted.
    const container = document.createElement("div");
    container.innerHTML = `<div data-live-region="polite">Saved.</div>`;
    expect(regionsOf(container)).toHaveLength(1);
    expect(politeText(container)).toBe("Saved.");
    expect(() => liveRegionText(container, "assertive")).toThrowError(/no assertive/);
  });
});
