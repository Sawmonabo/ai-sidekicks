// Ranked error entries. A transient error arriving a frame after a durable one must not take
// its Retry off the screen, so the case holds two entries at once and asserts which ranks highest.

import { describe, expect, it } from "vitest";

import { refuse } from "@renderer/lib/refusal.js";
import { TranscriptErrorTable } from "../transcript-errors.js";

const PROJECTION_FAILURE = refuse(
  "transcript",
  "renderer.row_projection_failed",
  "A row was unreadable.",
);
const GEOMETRY_FAILURE = refuse(
  "transcript",
  "renderer.geometry_unavailable",
  "The viewport was not measurable.",
);

describe("the transcript's error table", () => {
  it("ranks the durable failure above the transient one", () => {
    const errorTable = new TranscriptErrorTable();
    errorTable.record("geometry", GEOMETRY_FAILURE);
    errorTable.record("row-projection", PROJECTION_FAILURE);
    expect(errorTable.highest()?.kind).toBe("row-projection");
    expect(errorTable.entries().map((entry) => entry.kind)).toStrictEqual([
      "row-projection",
      "geometry",
    ]);
  });
});
