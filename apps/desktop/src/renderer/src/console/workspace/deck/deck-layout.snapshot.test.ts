// What a saved deck layout carries, and the five ways a saved one can be wrong.
//
// The restore cases are the point of this file. Three of the five are ORDINARY —
// a record written by another build, a pane kind this one has not got, an entity
// that no longer validates — so each has to be dropped and REPORTED rather than
// thrown, and the report has to be a value a surface can render. The fourth, the
// cap, is what stands between a hand-edited record and a window that mounts panes
// until it stops responding. The fifth is a record holding two pane ids at ONE
// address: `open()` cannot repair that, because focusing the first pane is all it
// ever does, so the duplicate mounts a second body, takes a second cap slot, and is
// written straight back on the next save. It is coalesced during decoding instead,
// first in position order winning.
//
// Every clean assertion below has a negative control, because the failure mode
// that matters here is a validator that passes everything.
//
// How the layout behaves when the deck moves it — opening, ordering, focus, and the
// panel group's settled sizes — is `deck-layout.test.ts`.

import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../workspace-bounds.js";
import { DeckLayout } from "./deck-layout.js";
import { DECK_LAYOUT_SNAPSHOT_VERSION, DECK_SNAPSHOT_HEADER_KEY } from "./deck-snapshot.js";

function emptyLayout(): DeckLayout {
  return new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
}

/** A layout holding one session-scoped timeline and one run-scoped inspector. */
function twoPaneLayout(): DeckLayout {
  const layout = emptyLayout();
  layout.open({ kind: "timeline", entity: undefined });
  layout.open({ kind: "inspector", entity: { kind: "run", id: "run-01" } });
  return layout;
}

describe("DeckLayout — what a snapshot carries", () => {
  it("round-trips panes, order, widths, focus, and density", () => {
    const layout = twoPaneLayout();
    const [, second] = layout.snapshot().panes;
    layout.focus(second?.paneId ?? "");
    layout.setDensity("compact");

    const restored = emptyLayout();
    const report = restored.restore(layout.toSnapshot());

    expect(report.refusals).toStrictEqual([]);
    expect(report.restoredPaneCount).toBe(2);
    expect(restored.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "timeline",
      "inspector",
    ]);
    expect(restored.snapshot().panes[1]?.entity).toStrictEqual({ kind: "run", id: "run-01" });
    expect(restored.snapshot().focusedPaneId).toBe(second?.paneId);
    expect(restored.snapshot().density).toBe("compact");
  });

  it("never writes an ephemeral pane", () => {
    // `deck-model.ts`'s `EPHEMERAL_PANE_KINDS`: a browser pane is never written to the
    // layout snapshot, so a restart cannot reopen a page nobody asked for.
    const layout = twoPaneLayout();
    const source = layout.snapshot().panes[0];
    layout.open({ kind: "browser", entity: undefined, sourcePaneId: source?.paneId ?? "" });
    const written = Object.values(layout.toSnapshot())
      .map((entry) => entry["kind"])
      .filter((kind) => kind !== undefined);
    expect(written).not.toContain("browser");
  });

  it("mints no pane id a restored pane already holds", () => {
    // Without the ordinal being read back, `close` would remove two panes and
    // `focus` would land on whichever the array reached first.
    const layout = twoPaneLayout();
    const restored = emptyLayout();
    restored.restore(layout.toSnapshot());
    const minted = restored.open({ kind: "approvals", entity: undefined });
    const ids = restored.snapshot().panes.map((pane) => pane.paneId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(minted);
  });
});

describe("DeckLayout — what a restore refuses", () => {
  it("discards a snapshot of an unknown version WHOLE", () => {
    // A grammar this build does not know is a grammar whose members it cannot
    // interpret, and a half-restored deck hides which half went missing.
    const layout = twoPaneLayout();
    const snapshot = layout.toSnapshot();
    const header = snapshot[DECK_SNAPSHOT_HEADER_KEY];
    if (header === undefined) {
      throw new Error("the snapshot carried no header");
    }
    header["version"] = DECK_LAYOUT_SNAPSHOT_VERSION + 1;

    const restored = emptyLayout();
    const report = restored.restore(snapshot);

    expect(report.restoredPaneCount).toBe(0);
    expect(restored.snapshot().panes).toStrictEqual([]);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "snapshot-version-unknown",
    ]);
  });

  it("negative control: the SAME snapshot at the current version restores whole", () => {
    // Without this, the case above would pass over a restore that discarded every
    // record it was ever handed.
    const restored = emptyLayout();
    expect(restored.restore(twoPaneLayout().toSnapshot()).restoredPaneCount).toBe(2);
  });

  it("drops a pane kind this build does not have, and keeps the rest", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-99"] = { position: 5, kind: "holodeck", sizePermille: 300 };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-kind-unknown"]);
  });

  it("drops a kind the console never saves, however it got into the record", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-98"] = { position: 5, kind: "browser", sizePermille: 300 };
    expect(emptyLayout().restore(snapshot).restoredPaneCount).toBe(2);
  });

  it("drops a pane whose entity is half-supplied rather than guessing the rest", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-97"] = { position: 5, kind: "inspector", sizePermille: 300, entityId: "run-02" };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-entity-invalid"]);
  });

  it("drops a pane whose entity kind is not one the console has", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-96"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "starship",
      entityId: "run-02",
    };
    expect(emptyLayout().restore(snapshot).restoredPaneCount).toBe(2);
  });

  it("caps how many panes one record can mount", () => {
    const layout = emptyLayout();
    const cap = 3;
    const capped = new DeckLayout({ restoredPaneCap: cap });
    for (let index = 0; index < cap + 2; index += 1) {
      layout.open({ kind: "inspector", entity: { kind: "run", id: `run-${String(index)}` } });
    }

    const report = capped.restore(layout.toSnapshot());

    expect(report.restoredPaneCount).toBe(cap);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["restore-cap-exceeded"]);
  });

  it("adopts one pane for a record holding two ids at one address", () => {
    // The corrupted or hand-edited shape: two DIFFERENT pane ids naming the same
    // kind over the same entity. Both decode cleanly, which is exactly why nothing
    // downstream catches it.
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-duplicate"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "run",
      entityId: "run-01",
    };

    const restored = emptyLayout();
    const report = restored.restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "pane-address-duplicate",
    ]);
    // First in POSITION order survives, which is the arrangement the person last
    // saw — not whichever id `Object.entries` happened to yield first.
    expect(restored.snapshot().panes.map((pane) => pane.paneId)).not.toContain("pane-duplicate");
  });

  it("counts the survivor once against the restore cap", () => {
    // A dropped duplicate must not push a real pane out of the restore, so the
    // record below holds cap-many distinct addresses plus one repeat of the first.
    const cap = 3;
    const source = emptyLayout();
    for (let index = 0; index < cap; index += 1) {
      source.open({ kind: "inspector", entity: { kind: "run", id: `run-${String(index)}` } });
    }
    const snapshot = source.toSnapshot();
    snapshot["pane-duplicate"] = {
      position: 1.5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "run",
      entityId: "run-0",
    };

    const report = new DeckLayout({ restoredPaneCap: cap }).restore(snapshot);

    expect(report.restoredPaneCount).toBe(cap);
    // The duplicate is the ONLY refusal: if it had consumed a slot, the last
    // distinct pane would have been dropped and the cap refusal raised beside it.
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "pane-address-duplicate",
    ]);
  });

  it("negative control: two panes at two addresses both restore, with no refusal", () => {
    // Without this, the two cases above would pass over a decoder that coalesced
    // every pane onto the first — the failure mode a dedupe introduces.
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-distinct"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "run",
      entityId: "run-02",
    };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(3);
    expect(report.refusals).toStrictEqual([]);
  });

  it("refuses a record that is not a layout record at all", () => {
    const report = emptyLayout().restore(["not", "a", "record"]);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "snapshot-shape-invalid",
    ]);
  });

  it("names itself in every refusal it raises", () => {
    // A refusal that names nobody is a refusal a surface three layers up cannot
    // attribute — `core/refusal.ts`'s own reason for the field.
    const report = emptyLayout().restore(null);
    for (const refusal of report.refusals) {
      expect(refusal.origin).toBe("deck-layout");
    }
  });
});

describe("DeckLayout — subscription", () => {
  it("publishes one state per mutation and nothing on a no-op", () => {
    const layout = twoPaneLayout();
    let notifications = 0;
    const unsubscribe = layout.subscribe(() => {
      notifications += 1;
    });

    layout.focus(layout.snapshot().panes[0]?.paneId ?? "");
    const afterRealChange = notifications;
    layout.focus(layout.snapshot().panes[0]?.paneId ?? "");
    layout.close("pane-does-not-exist");

    expect(afterRealChange).toBe(1);
    expect(notifications).toBe(1);
    unsubscribe();
  });
});
