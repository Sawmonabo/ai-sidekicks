// The one seat that is filled twice, and the refusal that makes the second time
// require the first to be deleted.
//
// The workspace family registers a fixture shell; the `timeline/` subtree Plan-013
// owns registers the real row later, in a PR that DELETES the shell. The seat is
// owner-scoped, so forgetting the deletion is not a cosmetic slip — the second
// registration is refused by name and the timeline stops rendering at import time.
// That loudness is the design, and this file is where it is checked.

import { afterEach, describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/index.js";
import {
  TIMELINE_ROW_DENSITIES,
  registerTimelineRowRenderer,
  timelineRowRenderer,
  unregisterTimelineRowRenderer,
  type TimelineRowRenderer,
} from "./timeline-row-slot.js";

/** A row body whose props are never read: these cases are about the seat. */
const fixtureShellRow: TimelineRowRenderer = () => null;

afterEach(() => {
  unregisterTimelineRowRenderer();
});

describe("timeline row slot — the absorb-by-import handover", () => {
  it("hands the list the body itself, not a wrapper", () => {
    registerTimelineRowRenderer("workspace-fixture-shell", fixtureShellRow);
    expect(timelineRowRenderer()).toBe(fixtureShellRow);
  });

  it("refuses the real row while the fixture shell is still registered", () => {
    // This IS the handover contract. The Plan-013 PR must delete the shell's
    // registration in the same diff; if it only adds its own, this refusal fires
    // at import time rather than leaving two bodies and an import-order winner.
    registerTimelineRowRenderer("workspace-fixture-shell", fixtureShellRow);
    expect(() => {
      registerTimelineRowRenderer("timeline-subtree", () => null);
    }).toThrow(DuplicateRegistrationError);
    expect(timelineRowRenderer()).toBe(fixtureShellRow);
  });

  it("admits the real row once the shell's registration is gone", () => {
    const realRow: TimelineRowRenderer = () => null;
    registerTimelineRowRenderer("workspace-fixture-shell", fixtureShellRow);
    unregisterTimelineRowRenderer();
    registerTimelineRowRenderer("timeline-subtree", realRow);
    expect(timelineRowRenderer()).toBe(realRow);
  });

  it("replaces when the same owner re-registers, as a hot reload does it", () => {
    const reloaded: TimelineRowRenderer = () => null;
    registerTimelineRowRenderer("timeline-subtree", fixtureShellRow);
    registerTimelineRowRenderer("timeline-subtree", reloaded);
    expect(timelineRowRenderer()).toBe(reloaded);
  });

  it("negative control: an unfilled seat has no body", () => {
    // Without this, every case above would pass over a seat that answered with a
    // body nobody registered — or with one an earlier case left behind.
    expect(timelineRowRenderer()).toBeUndefined();
  });
});

describe("timeline row slot — the density budget vocabulary", () => {
  it("is the two collapse states rule 7 names, each declared once", () => {
    // Two values and not a spacing scale: `Spec-023 §Console Design (Meridian)`
    // rule 7 is about what is COLLAPSED. A third member arriving here means the
    // rule grew a state, which is a spec question rather than a console one.
    expect([...TIMELINE_ROW_DENSITIES]).toStrictEqual(["collapsed", "expanded"]);
    expect(new Set(TIMELINE_ROW_DENSITIES).size).toBe(TIMELINE_ROW_DENSITIES.length);
  });
});
