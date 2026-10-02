// What a saved pane layout carries and the ways a saved one can be wrong. An unknown version,
// unknown kind or invalid entity is dropped and reported as a value a view can render, never
// thrown. The cap stops a hand-edited record mounting panes until the window hangs. A duplicate
// address is coalesced during decoding because `open()` cannot repair it. Each clean assertion
// has a negative control, since the failure that matters is a validator that passes everything.
// Live movement is in `pane-layout-store.test.ts`.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_RESTORED_PANE_CAP, PaneLayoutStore } from "./pane-layout-store.js";
import {
  PANE_LAYOUT_SNAPSHOT_VERSION,
  PANE_LAYOUT_SNAPSHOT_HEADER_KEY,
} from "./pane-layout-snapshot.js";

function emptyLayout(): PaneLayoutStore {
  return new PaneLayoutStore({ restoredPaneCap: PANE_LAYOUT_RESTORED_PANE_CAP });
}

/** A layout holding one session-scoped transcript and one worktree-scoped inspector. */
function twoPaneLayout(): PaneLayoutStore {
  const layout = emptyLayout();
  layout.open({ kind: "transcript" });
  layout.open({ kind: "inspector", entity: { kind: "worktree", id: "worktree-01" } });
  return layout;
}

describe("PaneLayoutStore — what a snapshot carries", () => {
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
      "transcript",
      "inspector",
    ]);
    expect(restored.snapshot().panes[1]?.entity).toStrictEqual({
      kind: "worktree",
      id: "worktree-01",
    });
    expect(restored.snapshot().focusedPaneId).toBe(second?.paneId);
    expect(restored.snapshot().density).toBe("compact");
  });

  it("never writes an ephemeral pane", () => {
    // A browser pane is ephemeral and never written, so a restart cannot reopen a page nobody
    // asked for.
    const layout = twoPaneLayout();
    const source = layout.snapshot().panes[0];
    layout.open({ kind: "browser" }, { linkedSourcePaneId: source?.paneId ?? "" });
    const written = Object.values(layout.toSnapshot())
      .map((entry) => entry["kind"])
      .filter((kind) => kind !== undefined);
    expect(written).not.toContain("browser");
  });

  it("mints no pane id a restored pane already holds", () => {
    // Without the ordinal read back, a new pane could reuse a restored id.
    const layout = twoPaneLayout();
    const restored = emptyLayout();
    restored.restore(layout.toSnapshot());
    const minted = restored.open({ kind: "agents" });
    const ids = restored.snapshot().panes.map((pane) => pane.paneId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(minted);
  });
});

describe("PaneLayoutStore — what a restore refuses", () => {
  it("discards a snapshot of an unknown version WHOLE", () => {
    // A half-restored layout hides which half went missing.
    const layout = twoPaneLayout();
    const snapshot = layout.toSnapshot();
    const header = snapshot[PANE_LAYOUT_SNAPSHOT_HEADER_KEY];
    if (header === undefined) {
      throw new Error("the snapshot carried no header");
    }
    header["version"] = PANE_LAYOUT_SNAPSHOT_VERSION + 1;

    const restored = emptyLayout();
    const report = restored.restore(snapshot);

    expect(report.restoredPaneCount).toBe(0);
    expect(restored.snapshot().panes).toStrictEqual([]);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "snapshot-version-unknown",
    ]);
  });

  it("drops a pane kind this build does not have, and keeps the rest", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-99"] = { position: 5, kind: "holodeck", sizePermille: 300 };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-kind-unknown"]);
  });

  it("drops a kind the app never saves, however it got into the record", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-98"] = { position: 5, kind: "browser", sizePermille: 300 };
    expect(emptyLayout().restore(snapshot).restoredPaneCount).toBe(2);
  });

  it("drops a pane whose entity is half-supplied rather than guessing the rest", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-97"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityId: "worktree-02",
    };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-entity-invalid"]);
  });

  it("caps how many panes one record can mount", () => {
    const layout = emptyLayout();
    const cap = 3;
    const capped = new PaneLayoutStore({ restoredPaneCap: cap });
    for (let index = 0; index < cap + 2; index += 1) {
      layout.open({
        kind: "inspector",
        entity: { kind: "worktree", id: `worktree-${String(index)}` },
      });
    }

    const report = capped.restore(layout.toSnapshot());

    expect(report.restoredPaneCount).toBe(cap);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["restore-cap-exceeded"]);
  });

  it("adopts one pane for a record holding two ids at one address", () => {
    // Two different pane ids naming the same kind and entity. Both decode cleanly, so nothing
    // downstream would catch it.
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-duplicate"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "worktree",
      entityId: "worktree-01",
    };

    const restored = emptyLayout();
    const report = restored.restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "pane-address-duplicate",
    ]);
    // First in position order survives, not whichever id `Object.entries` yields first.
    expect(restored.snapshot().panes.map((pane) => pane.paneId)).not.toContain("pane-duplicate");
  });

  it("counts the survivor once against the restore cap", () => {
    // A dropped duplicate must not push a real pane out, so the record holds cap-many distinct
    // addresses plus one repeat.
    const cap = 3;
    const source = emptyLayout();
    for (let index = 0; index < cap; index += 1) {
      source.open({
        kind: "inspector",
        entity: { kind: "worktree", id: `worktree-${String(index)}` },
      });
    }
    const snapshot = source.toSnapshot();
    snapshot["pane-duplicate"] = {
      position: 1.5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "worktree",
      entityId: "worktree-0",
    };

    const report = new PaneLayoutStore({ restoredPaneCap: cap }).restore(snapshot);

    expect(report.restoredPaneCount).toBe(cap);
    // The duplicate is the only refusal; counting it against the cap would drop a real pane.
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual([
      "pane-address-duplicate",
    ]);
  });

  it("negative control: two panes at two addresses both restore, with no refusal", () => {
    // The two cases above would also pass over a decoder that coalesced every pane onto the first.
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-distinct"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "worktree",
      entityId: "worktree-02",
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
});
