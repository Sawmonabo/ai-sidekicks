// The termination matrix, asserted.
//
// THE ASSERTION ROLE AND NOTHING ELSE. The axes are declared in
// `termination-matrix-axes.test-support.ts`, the scripted platform in
// `termination-matrix-tools.test-support.ts`, and the table itself in
// `termination-matrix-catalog.test-support.ts` — three roles that were the first
// five hundred lines of this file, which meant the two claims a reader opens it
// for were the last thing in it. Every cell's own reasoning stays with the cell,
// where it is read beside the state it explains.
//
// TWO CLAIMS, AND THE SECOND IS ABOUT THE FIRST. Every cell answers with the
// verdict it owes, and every axis value is carried by at least one cell — the
// second is what stops the table from quietly ceasing to be one, either by a
// value nothing exercises or by a cell deleted with the last carrier of its own.

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
    // The enumeration's own control. A cell added for a new finding with an axis
    // value nothing else carries is the case this catches; so is an axis value
    // whose only cell was deleted, which is how a matrix stops being one.
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
