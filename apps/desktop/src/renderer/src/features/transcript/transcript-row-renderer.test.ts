// The transcript row renderer's registry: one renderer, owner-scoped. A second owner
// is refused by name rather than leaving two bodies and an import-order winner, and
// this file is where that refusal is checked.

import { afterEach, describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "@renderer/lib/keyed-registry.js";
import {
  TRANSCRIPT_ROW_DENSITIES,
  registerTranscriptRowRenderer,
  findTranscriptRowRenderer,
  unregisterTranscriptRowRenderer,
  type TranscriptRowRenderer,
} from "./transcript-row-renderer.js";

/** A row body whose props are never read: these cases are about the registry. */
const registeredRow: TranscriptRowRenderer = () => null;

afterEach(() => {
  unregisterTranscriptRowRenderer();
});

describe("transcript row renderer — one owner", () => {
  it("hands the list the body itself, not a wrapper", () => {
    registerTranscriptRowRenderer("transcript-rows", registeredRow);
    expect(findTranscriptRowRenderer()).toBe(registeredRow);
  });

  it("refuses a second owner while the first is registered", () => {
    // A second owner fires this refusal at import time rather than leaving two bodies
    // and an import-order winner.
    registerTranscriptRowRenderer("transcript-rows", registeredRow);
    expect(() => {
      registerTranscriptRowRenderer("another-owner", () => null);
    }).toThrow(DuplicateRegistrationError);
    expect(findTranscriptRowRenderer()).toBe(registeredRow);
  });

  it("admits another owner once the first registration is released", () => {
    const otherRow: TranscriptRowRenderer = () => null;
    registerTranscriptRowRenderer("transcript-rows", registeredRow);
    unregisterTranscriptRowRenderer();
    registerTranscriptRowRenderer("another-owner", otherRow);
    expect(findTranscriptRowRenderer()).toBe(otherRow);
  });

  it("replaces when the same owner re-registers, as a hot reload does it", () => {
    const reloaded: TranscriptRowRenderer = () => null;
    registerTranscriptRowRenderer("transcript-rows", registeredRow);
    registerTranscriptRowRenderer("transcript-rows", reloaded);
    expect(findTranscriptRowRenderer()).toBe(reloaded);
  });

  it("negative control: an empty registry has no body", () => {
    // Without this, every case above would pass over a registry that answered with a
    // body nobody registered — or with one an earlier case left behind.
    expect(findTranscriptRowRenderer()).toBeUndefined();
  });
});

describe("transcript row renderer — the density budget vocabulary", () => {
  it("is the two collapse states the density rule names, each declared once", () => {
    // Two values and not a spacing scale: the density rule is about what is
    // COLLAPSED. A third member arriving here means the rule grew a state, which is
    // a design question rather than a console one.
    expect([...TRANSCRIPT_ROW_DENSITIES]).toStrictEqual(["collapsed", "expanded"]);
    expect(new Set(TRANSCRIPT_ROW_DENSITIES).size).toBe(TRANSCRIPT_ROW_DENSITIES.length);
  });
});
