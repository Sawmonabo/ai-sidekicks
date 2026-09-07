// A layout snapshot never carries a browser pane, on either side of the seam.
//
// The two claims are separate because the two sides fail differently: a write filter
// that stopped filtering would put the pane in tomorrow's snapshot, and a restore that
// stopped dropping would re-open one out of yesterday's. So each is driven directly,
// and the pair is what makes "the pane is ephemeral" true rather than intended.

import { describe, expect, it } from "vitest";

import {
  LAYOUT_RESTORE_REFUSAL_ORIGIN,
  panesForLayoutSnapshot,
  panesFromLayoutSnapshot,
} from "./layout-snapshot.js";
import { EPHEMERAL_PANE_KINDS, PANE_KINDS, isEphemeralPaneKind } from "./pane-kinds.js";

describe("the ephemeral pane kinds", () => {
  it("names only kinds this deck has", () => {
    for (const kind of EPHEMERAL_PANE_KINDS) {
      expect(PANE_KINDS).toContain(kind);
    }
  });

  it("holds the browser pane and not the timeline", () => {
    expect(isEphemeralPaneKind("browser")).toBe(true);
    // The negative control: a predicate answering `true` for everything would pass
    // the case above and empty every snapshot.
    expect(isEphemeralPaneKind("timeline")).toBe(false);
  });
});

describe("what a layout snapshot is written with", () => {
  it("drops an ephemeral pane and keeps every other kind", () => {
    const panes = [
      { kind: "timeline" as const, address: "session:s1" },
      { kind: "browser" as const, address: "session:s1" },
      { kind: "runs" as const, address: "session:s1" },
    ];
    expect(panesForLayoutSnapshot(panes)).toStrictEqual([panes[0], panes[2]]);
  });

  it("carries every member the deck put on a row", () => {
    // Generic over the row, so a deck member the filter never heard of survives it.
    const panes = [{ kind: "runs" as const, address: "session:s1", widthFraction: 0.4 }];
    expect(panesForLayoutSnapshot(panes)).toStrictEqual(panes);
  });
});

describe("what a restore re-opens", () => {
  it("never re-opens a browser pane, whatever an older build wrote", () => {
    const reading = panesFromLayoutSnapshot([
      { kind: "browser", address: "session:s1" },
      { kind: "timeline", address: "session:s1" },
    ]);
    expect(reading.restored.map((entry) => entry.kind)).toStrictEqual(["timeline"]);
    expect(reading.dropped).toStrictEqual([
      {
        kind: "browser",
        refusal: {
          origin: LAYOUT_RESTORE_REFUSAL_ORIGIN,
          code: "ephemeral-kind",
          detail: expect.stringContaining("never restored"),
        },
      },
    ]);
  });

  it("drops and reports a kind this build does not have", () => {
    const reading = panesFromLayoutSnapshot([
      { kind: "hologram", address: "session:s1" },
      { kind: 7, address: "session:s1" },
    ]);
    expect(reading.restored).toStrictEqual([]);
    // The kind is kept VERBATIM beside the refusal — a string this build does not
    // know and a value that is not a string at all — so the deck renders what the
    // snapshot held rather than a sentence about it.
    expect(reading.dropped.map((drop) => drop.kind)).toStrictEqual(["hologram", 7]);
    expect(reading.dropped.map((drop) => drop.refusal.code)).toStrictEqual([
      "unknown-kind",
      "unknown-kind",
    ]);
  });

  it("restores a known durable kind and reports nothing", () => {
    const reading = panesFromLayoutSnapshot([{ kind: "approvals", address: "session:s1" }]);
    expect(reading.restored).toStrictEqual([{ kind: "approvals", address: "session:s1" }]);
    expect(reading.dropped).toStrictEqual([]);
  });
});
