// The rail's tick vocabulary — the table, and the legend it has to tell the truth in.
//
// Two claims, and each one fails quietly. A table missing a binding still paints, as
// a mark with no glyph and the wrong hue. And a legend listing ten kinds while the
// daemon can emit eight still paints, as a promise the session never keeps. So both
// are asserted positively and again against the case that would pass if the rule had
// been dropped.

import { describe, expect, it } from "vitest";

import {
  RAIL_TICK_BINDINGS,
  RAIL_TICK_KINDS,
  RAIL_TICK_TONES,
  railTickKindsWithoutRegisteredWire,
} from "./rail-ticks.js";
import { LedgerSeamIndex } from "./seams.js";

describe("rail — the tick table is closed and total", () => {
  it("carries one binding per kind, keyed by the kind it names", () => {
    expect(RAIL_TICK_KINDS).toHaveLength(10);
    for (const kind of RAIL_TICK_KINDS) {
      const binding = RAIL_TICK_BINDINGS[kind];
      expect(binding.kind).toBe(kind);
      expect(RAIL_TICK_TONES).toContain(binding.tone);
      // Every kind is produced by something: a direct wire type or a seam kind.
      expect(binding.wireTypes.length + binding.seamKinds.length).toBeGreaterThan(0);
    }
  });

  it("spends amber on the one pending-human mark and red on the one failure", () => {
    const attention = RAIL_TICK_KINDS.filter(
      (kind) => RAIL_TICK_BINDINGS[kind].tone === "attention",
    );
    const failure = RAIL_TICK_KINDS.filter((kind) => RAIL_TICK_BINDINGS[kind].tone === "failure");
    expect(attention).toStrictEqual(["approval"]);
    expect(failure).toStrictEqual(["tool-error"]);
  });

  it("negative control: no seam-derived kind is coloured", () => {
    // A rewind, a compaction, and a switch are history, not attention. A table
    // that had spent amber on them would still render — in a rail where nothing
    // stands out because everything does.
    for (const kind of [
      "rollback-epoch",
      "compaction",
      "provider-switch",
      "park",
      "resume",
    ] as const) {
      expect(RAIL_TICK_BINDINGS[kind].tone).toBe("actor");
    }
  });

  it("reads seam-derived kinds through seam kinds, never by repeating wire types", () => {
    // The drift guard: a second copy of the seam vocabulary here would go stale
    // silently. These five carry no wire types of their own at all.
    for (const kind of [
      "park",
      "resume",
      "rollback-epoch",
      "compaction",
      "provider-switch",
    ] as const) {
      expect(RAIL_TICK_BINDINGS[kind].wireTypes).toStrictEqual([]);
      expect(RAIL_TICK_BINDINGS[kind].seamKinds.length).toBeGreaterThan(0);
    }
  });
});

describe("rail — the legend reports what the daemon cannot yet emit", () => {
  it("names only the kinds whose every wire type is unregistered", () => {
    // A legend listing ten kinds while the daemon can produce eight is a legend
    // that lies about the session. `park` is deliberately absent — `run.paused`
    // IS registered, so that mark works today.
    expect(railTickKindsWithoutRegisteredWire(new LedgerSeamIndex())).toStrictEqual([
      "resume",
      "provider-switch",
    ]);
  });

  it("negative control: the marks that do work are not reported missing", () => {
    const missing = railTickKindsWithoutRegisteredWire(new LedgerSeamIndex());
    for (const kind of [
      "participant-message",
      "approval",
      "tool-error",
      "handoff",
      "park",
      "rollback-epoch",
      "compaction",
      "artifact-publication",
    ] as const) {
      expect(missing).not.toContain(kind);
    }
  });
});
