// The one seat that is filled twice, and the refusal that makes the second time
// require the first to be deleted.
//
// The workspace family registers a fixture shell; the `timeline/` subtree registers the
// real row later, in a PR that DELETES the shell. The seat is owner-scoped, so
// forgetting the deletion is not a cosmetic slip — the second registration is refused
// by name and the timeline stops rendering at import time. That loudness is the design,
// and this file is where it is checked.

import { afterEach, describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  TRANSCRIPT_ROW_DENSITIES,
  registerTranscriptRowRenderer,
  findTranscriptRowRenderer,
  unregisterTranscriptRowRenderer,
  type TranscriptRowRenderer,
} from "./transcript-row-renderer.js";

/** A row body whose props are never read: these cases are about the seat. */
const fixtureShellRow: TranscriptRowRenderer = () => null;

afterEach(() => {
  unregisterTranscriptRowRenderer();
});

describe("timeline row slot — the absorb-by-import handover", () => {
  it("hands the list the body itself, not a wrapper", () => {
    registerTranscriptRowRenderer("workspace-fixture-shell", fixtureShellRow);
    expect(findTranscriptRowRenderer()).toBe(fixtureShellRow);
  });

  it("refuses the real row while the fixture shell is still registered", () => {
    // This IS the handover contract. The timeline subtree's PR must delete the
    // shell's registration in the same diff; if it only adds its own, this refusal fires
    // at import time rather than leaving two bodies and an import-order winner.
    registerTranscriptRowRenderer("workspace-fixture-shell", fixtureShellRow);
    expect(() => {
      registerTranscriptRowRenderer("timeline-subtree", () => null);
    }).toThrow(DuplicateRegistrationError);
    expect(findTranscriptRowRenderer()).toBe(fixtureShellRow);
  });

  it("admits the real row once the shell's registration is gone", () => {
    const realRow: TranscriptRowRenderer = () => null;
    registerTranscriptRowRenderer("workspace-fixture-shell", fixtureShellRow);
    unregisterTranscriptRowRenderer();
    registerTranscriptRowRenderer("timeline-subtree", realRow);
    expect(findTranscriptRowRenderer()).toBe(realRow);
  });

  it("replaces when the same owner re-registers, as a hot reload does it", () => {
    const reloaded: TranscriptRowRenderer = () => null;
    registerTranscriptRowRenderer("timeline-subtree", fixtureShellRow);
    registerTranscriptRowRenderer("timeline-subtree", reloaded);
    expect(findTranscriptRowRenderer()).toBe(reloaded);
  });

  it("negative control: an unfilled seat has no body", () => {
    // Without this, every case above would pass over a seat that answered with a
    // body nobody registered — or with one an earlier case left behind.
    expect(findTranscriptRowRenderer()).toBeUndefined();
  });
});

describe("timeline row slot — the density budget vocabulary", () => {
  it("is the two collapse states the density rule names, each declared once", () => {
    // Two values and not a spacing scale: the density rule is about what is
    // COLLAPSED. A third member arriving here means the rule grew a state, which is
    // a design question rather than a console one.
    expect([...TRANSCRIPT_ROW_DENSITIES]).toStrictEqual(["collapsed", "expanded"]);
    expect(new Set(TRANSCRIPT_ROW_DENSITIES).size).toBe(TRANSCRIPT_ROW_DENSITIES.length);
  });
});
