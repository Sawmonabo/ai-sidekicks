// The deck's layout, and the four ways a saved one can be wrong.
//
// The restore cases are the point of this file. Three of the four are ORDINARY —
// a record written by another build, a pane kind this one has not got, an entity
// that no longer validates — so each has to be dropped and REPORTED rather than
// thrown, and the report has to be a value a surface can render. The fourth, the
// cap, is what stands between a hand-edited record and a window that mounts panes
// until it stops responding.
//
// Every clean assertion below has a negative control, because the failure mode
// that matters here is a validator that passes everything.

import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../../core/index.js";
import { DeckLayout } from "./deck-layout.js";
import { DECK_TOTAL_PERMILLE } from "./deck-model.js";
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

describe("DeckLayout — one entity, one pane", () => {
  it("focuses the pane that already shows an entity rather than opening a second", () => {
    const layout = emptyLayout();
    const first = layout.open({ kind: "inspector", entity: { kind: "run", id: "run-01" } });
    const second = layout.open({ kind: "inspector", entity: { kind: "run", id: "run-01" } });

    expect(second).toBe(first);
    expect(layout.snapshot().panes).toHaveLength(1);
    expect(layout.snapshot().focusedPaneId).toBe(first);
  });

  it("negative control: the same entity in a different KIND of pane opens a second", () => {
    // Without this, the case above would pass over a layout that refused every
    // second open — and a run legitimately appears in both a runs list and an
    // inspector.
    const layout = emptyLayout();
    layout.open({ kind: "inspector", entity: { kind: "run", id: "run-01" } });
    layout.open({ kind: "runs", entity: { kind: "run", id: "run-01" } });
    expect(layout.snapshot().panes).toHaveLength(2);
  });
});

describe("DeckLayout — order, focus, and the ephemeral cascade", () => {
  it("opens a pane beside its source rather than at the end", () => {
    const layout = twoPaneLayout();
    const [first] = layout.snapshot().panes;
    layout.open({
      kind: "browser",
      entity: undefined,
      ...(first === undefined ? {} : { sourcePaneId: first.paneId }),
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "timeline",
      "browser",
      "inspector",
    ]);
  });

  it("closes an ephemeral pane with the pane it opened beside", () => {
    const layout = twoPaneLayout();
    const source = layout.snapshot().panes[0];
    if (source === undefined) {
      throw new Error("the fixture opened no panes");
    }
    layout.open({ kind: "browser", entity: undefined, sourcePaneId: source.paneId });
    layout.close(source.paneId);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["inspector"]);
  });

  it("negative control: closing a pane leaves a browser opened beside a DIFFERENT one", () => {
    const layout = twoPaneLayout();
    const [source, other] = layout.snapshot().panes;
    if (source === undefined || other === undefined) {
      throw new Error("the fixture opened too few panes");
    }
    layout.open({ kind: "browser", entity: undefined, sourcePaneId: other.paneId });
    layout.close(source.paneId);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "browser",
    ]);
  });

  it("cycles focus in both directions, wrapping at each end", () => {
    const layout = twoPaneLayout();
    const [first, second] = layout.snapshot().panes;
    layout.focus(first?.paneId ?? "");
    layout.focusAdjacent(1);
    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
    layout.focusAdjacent(1);
    expect(layout.snapshot().focusedPaneId).toBe(first?.paneId);
    layout.focusAdjacent(-1);
    expect(layout.snapshot().focusedPaneId).toBe(second?.paneId);
  });

  it("moves a pane one position and stops at the ends", () => {
    const layout = twoPaneLayout();
    const [first] = layout.snapshot().panes;
    layout.movePane(first?.paneId ?? "", 1);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "timeline",
    ]);
    layout.movePane(first?.paneId ?? "", 1);
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "timeline",
    ]);
  });
});

describe("DeckLayout — resize", () => {
  it("moves width between the two panes a separator sits between, and no others", () => {
    const layout = twoPaneLayout();
    layout.open({ kind: "runs", entity: undefined });
    const before = layout.snapshot().panes.map((pane) => pane.sizePermille);
    const [first] = layout.snapshot().panes;
    layout.resize(first?.paneId ?? "", 60, 0);
    const after = layout.snapshot().panes.map((pane) => pane.sizePermille);

    expect(after[0]).toBe((before[0] ?? 0) + 60);
    expect(after[1]).toBe((before[1] ?? 0) - 60);
    expect(after[2]).toBe(before[2]);
    expect(after.reduce((sum, size) => sum + size, 0)).toBe(DECK_TOTAL_PERMILLE);
  });

  it("negative control: the floor stops a pane being squeezed past it", () => {
    const layout = twoPaneLayout();
    const [first] = layout.snapshot().panes;
    const floor = 400;
    layout.resize(first?.paneId ?? "", DECK_TOTAL_PERMILLE, floor);
    expect(layout.snapshot().panes[1]?.sizePermille).toBe(floor);
  });
});

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
    // §4.2: a browser pane "is ephemeral: it is never written to the layout
    // snapshot", so a restart cannot reopen a page nobody asked for.
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
