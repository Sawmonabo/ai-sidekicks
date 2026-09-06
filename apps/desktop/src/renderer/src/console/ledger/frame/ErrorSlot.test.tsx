// Ranked slots, and a row that names its own failure.
//
// The ranking is the whole subject: the failure the design guards against is a
// transient error arriving a frame after a durable one and taking its Retry off the
// screen. So every case here holds TWO slots at once and asserts which one is the
// card.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import { LEDGER_ERROR_KINDS, LedgerErrorSlot, LedgerErrorSlots } from "./ErrorSlot.js";

const PROJECTION_FAILURE = refuse(
  "ledger",
  "renderer.row_projection_failed",
  "A row was unreadable.",
);
const GEOMETRY_FAILURE = refuse(
  "ledger",
  "renderer.geometry_unavailable",
  "The viewport was not measurable.",
);

describe("the ledger's error slots", () => {
  it("ranks the durable failure above the transient one", () => {
    const slots = new LedgerErrorSlots();
    slots.record("geometry", GEOMETRY_FAILURE);
    slots.record("row-projection", PROJECTION_FAILURE);
    expect(slots.highest()?.kind).toBe("row-projection");
    expect(slots.entries().map((entry) => entry.kind)).toStrictEqual([
      "row-projection",
      "geometry",
    ]);
  });

  it("negative control: the rank is the declaration order, not the recording order", () => {
    // Recorded the other way round; the answer must not move.
    const slots = new LedgerErrorSlots();
    slots.record("row-projection", PROJECTION_FAILURE);
    slots.record("geometry", GEOMETRY_FAILURE);
    expect(slots.entries().map((entry) => entry.kind)).toStrictEqual([
      "row-projection",
      "geometry",
    ]);
    expect([...LEDGER_ERROR_KINDS]).toStrictEqual([
      "row-projection",
      "reveal",
      "prune",
      "geometry",
    ]);
  });

  it("clears one slot without touching the others", () => {
    const slots = new LedgerErrorSlots();
    slots.record("geometry", GEOMETRY_FAILURE);
    slots.record("row-projection", PROJECTION_FAILURE);
    slots.clear("geometry");
    expect(slots.occupiedSlotCount).toBe(1);
    expect(slots.highest()?.kind).toBe("row-projection");
  });

  it("renders the highest as a card and the rest inline, and renders nothing when empty", () => {
    const slots = new LedgerErrorSlots();
    slots.record("geometry", GEOMETRY_FAILURE);
    slots.record("row-projection", PROJECTION_FAILURE);
    const { container } = render(<LedgerErrorSlot entries={slots.entries()} />);
    expect(container.querySelectorAll(".meridian-refusal--card")).toHaveLength(1);
    expect(container.querySelectorAll(".meridian-refusal--inline")).toHaveLength(1);
    expect(screen.getByText("renderer.row_projection_failed")).toBeDefined();

    const empty = render(<LedgerErrorSlot entries={[]} />);
    expect(empty.container.innerHTML).toBe("");
  });
});
