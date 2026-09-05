// The deck's layout, driven: what one entity opens, what order and focus do, and what
// the panel group's settled sizes are allowed to change.
//
// Split from `deck-layout.snapshot.test.ts`, which is about what a saved layout
// carries and the five ways a restored one can be wrong. This half touches no
// snapshot at all — it is the layout as the deck itself moves it.

import { describe, expect, it } from "vitest";

import { DECK_RESTORED_PANE_CAP } from "../workspace-bounds.js";
import { DeckLayout } from "./deck-layout.js";
import { DECK_TOTAL_PERMILLE } from "./deck-model.js";

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

describe("DeckLayout — adopting what the panel group settled on", () => {
  it("takes the group's percentages as the deck's widths, still summing to the total", () => {
    const layout = twoPaneLayout();
    layout.open({ kind: "runs", entity: undefined });
    const paneIds = layout.snapshot().panes.map((pane) => pane.paneId);

    layout.applyLayout(
      { [paneIds[0] ?? ""]: 50, [paneIds[1] ?? ""]: 30, [paneIds[2] ?? ""]: 20 },
      0,
    );

    const after = layout.snapshot().panes.map((pane) => pane.sizePermille);
    expect(after).toStrictEqual([500, 300, 200]);
    expect(after.reduce((sum, size) => sum + size, 0)).toBe(DECK_TOTAL_PERMILLE);
  });

  it("clamps a width below the floor IN THE STORE, whatever the DOM reported", () => {
    // The subject is the persisted value, not the rendered one: a width below the
    // floor that reached the store would be written to disk and restored on the next
    // launch, where no drag is happening for the library's own clamp to run in.
    const layout = twoPaneLayout();
    const paneIds = layout.snapshot().panes.map((pane) => pane.paneId);
    const floorPermille = 400;

    layout.applyLayout({ [paneIds[0] ?? ""]: 95, [paneIds[1] ?? ""]: 5 }, floorPermille);

    const after = layout.snapshot().panes.map((pane) => pane.sizePermille);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(floorPermille);
    expect(after.reduce((sum, size) => sum + size, 0)).toBe(DECK_TOTAL_PERMILLE);
  });

  it("negative control: with no floor the same layout is adopted unclamped", () => {
    // Without this the case above would pass over a store that clamped every width
    // to some fixed minimum of its own, which would make the floor argument dead.
    const layout = twoPaneLayout();
    const paneIds = layout.snapshot().panes.map((pane) => pane.paneId);
    layout.applyLayout({ [paneIds[0] ?? ""]: 95, [paneIds[1] ?? ""]: 5 }, 0);
    expect(layout.snapshot().panes.map((pane) => pane.sizePermille)).toStrictEqual([950, 50]);
  });

  it("negative control: a report that changes nothing raises no revision", () => {
    // The guard that stops the write-back looping: the group reports its layout
    // after every commit, including the ones this method caused.
    const layout = twoPaneLayout();
    const revisionBefore = layout.snapshot().revision;
    const percentages = Object.fromEntries(
      layout.snapshot().panes.map((pane) => [pane.paneId, pane.sizePermille / 10]),
    );
    layout.applyLayout(percentages, 0);
    expect(layout.snapshot().revision).toBe(revisionBefore);
  });
});
