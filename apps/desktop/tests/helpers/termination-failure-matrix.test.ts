// Asserts the termination matrix. The axes are in `termination-matrix-axes.test-support.ts`, the
// scripted platform in `termination-matrix-tools.test-support.ts`, the table in
// `termination-matrix-catalog.test-support.ts`. Two claims: every cell answers with the verdict
// it owes, and every axis value is carried by at least one cell, so the table cannot quietly
// stop being one.

import { describe, expect, it } from "vitest";

import { LIFETIME_TEST_TIMEOUT_MS } from "./electron-child-lifetime.test-support.js";
import {
  type TerminationAxes,
  type TerminationCell,
} from "./termination-matrix-axes.test-support.js";
import { TERMINATION_MATRIX } from "./termination-matrix-catalog.test-support.js";

describe("the termination path, enumerated over every state it is asked in", () => {
  it.each(TERMINATION_MATRIX)(
    "$name",
    async (cell: TerminationCell) => {
      expect(
        await cell.answer(),
        `${cell.name} — root ${cell.axes.root}, platform ${cell.axes.platformAnswer}, ` +
          `${cell.axes.treeMode} mode, ${cell.axes.surviving} surviving, ` +
          `registration ${cell.axes.settleRegistration}`,
      ).toBe(cell.owedTermination);
    },
    // The scripted cells settle in microseconds; the spawning one takes the tier's.
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it("covers every axis value at least once, so the table cannot go stale silently", () => {
    // The matrix's own control: catches a new cell whose axis value nothing else carries, and an
    // axis value whose only cell was deleted.
    const covered = (reader: (axes: TerminationAxes) => string): string[] =>
      [...new Set(TERMINATION_MATRIX.map((cell) => reader(cell.axes)))].sort();
    expect(covered((axes) => axes.root)).toStrictEqual([
      "alive",
      "exited-holding-stdio",
      "reaped-with-a-stale-parent-row",
      "reaped-with-nothing-behind-it",
      "recycled",
    ]);
    expect(covered((axes) => axes.platformAnswer)).toStrictEqual([
      "delivered",
      "never-asked",
      "refused-then-delivered",
      "refused-throughout",
    ]);
    // Covered on either platform: every other cell names its mode, this one reads it.
    expect(covered((axes) => axes.treeMode)).toStrictEqual(["external", "signal"]);
    expect(covered((axes) => axes.surviving)).toStrictEqual([
      "descendant",
      "nothing",
      "unobservable",
      "unreaped-zombie",
      "unverifiable-claimant",
    ]);
    expect(covered((axes) => axes.settleRegistration)).toStrictEqual(["accepted", "refused"]);
  });
});
