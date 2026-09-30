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

  it("negative control: the SAME snapshot at the current version restores whole", () => {
    // The case above would also pass over a restore that discarded every record.
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

  it("drops a pane whose entity kind that pane kind is not a view of", () => {
    // `transcript` is a view of the session, not of an artifact. A weaker admission would leave
    // a pane nothing can render, counted against the cap and saved again.
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-95"] = {
      position: 5,
      kind: "transcript",
      sizePermille: 300,
      entityKind: "artifact",
      entityId: "artifact-02",
    };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-entity-invalid"]);
  });

  it("drops a pane whose entity id is not identifier-shaped", () => {
    // A non-empty id is not a valid one: a path separator makes a store key that cannot exist.
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-94"] = {
      position: 5,
      kind: "inspector",
      sizePermille: 300,
      entityKind: "worktree",
      entityId: "bad/id",
    };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-entity-invalid"]);
  });

  it("drops a pane that must name an entity and names none", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-93"] = { position: 5, kind: "inspector", sizePermille: 300 };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-entity-invalid"]);
  });

  it("drops a session-scoped pane the record opened over an entity", () => {
    const snapshot = twoPaneLayout().toSnapshot();
    snapshot["pane-92"] = {
      position: 5,
      kind: "terminal",
      sizePermille: 300,
      entityKind: "worktree",
      entityId: "worktree-02",
    };

    const report = emptyLayout().restore(snapshot);

    expect(report.restoredPaneCount).toBe(2);
    expect(report.refusals.map((refusal) => refusal.code)).toStrictEqual(["pane-entity-invalid"]);
  });

  it("negative control: the same pane kinds over the entities they ARE views of restore", () => {
    // The cases above would also pass over an admission that rejected every entity.
    const layout = emptyLayout();
    layout.open({ kind: "transcript" });
    layout.open({ kind: "inspector", entity: { kind: "worktree", id: "worktree-01" } });
    layout.open({ kind: "terminal" });

    expect(emptyLayout().restore(layout.toSnapshot()).restoredPaneCount).toBe(3);
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

  it("names itself in every refusal it raises", () => {
    // A refusal must name its origin so a view can attribute it.
    const report = emptyLayout().restore(null);
    for (const refusal of report.refusals) {
      expect(refusal.origin).toBe("pane-layout");
    }
  });
});

describe("PaneLayoutStore — subscription", () => {
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
