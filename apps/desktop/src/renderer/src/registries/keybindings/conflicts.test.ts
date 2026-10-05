// The pre-flight half of the binding table: `prepareBindings` and `detectConflicts` back both the
// settings page preview and `setBindings`.

import { describe, expect, it } from "vitest";

import { detectConflicts, prepareBindings } from "./conflicts.js";
import type { Keybinding } from "../commands/types.js";

/** One binding, so each test names only what it is about. */
function binding(chord: string, commandId: string, when?: string): Keybinding {
  return when === undefined ? { chord, commandId } : { chord, commandId, when };
}

describe("prepareBindings — which rows are well formed at all", () => {
  it("drops a scope that does not parse, and does not drop the rest of the set", () => {
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+Shift+p", "palette.open"),
      binding("$mod+j", "jump.next", "sessionOpen &&"),
    ]);

    expect(prepared.map((entry) => entry.binding.commandId)).toStrictEqual(["palette.open"]);
    expect(diagnostics[0]?.reason).toBe("when-unparseable");
  });
});

describe("detectConflicts — which surviving pairs can fire on one keystroke", () => {
  it("finds a conflict between scopes spelled differently that still overlap", () => {
    // A conflict means both can be live at once, not that the clauses are spelled alike.
    const { prepared } = prepareBindings([
      binding("$mod+k", "broad", "sessionOpen"),
      binding("$mod+k", "narrow", "sessionOpen && paneFocused"),
    ]);
    const conflicts = detectConflicts(prepared);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe("overlapping-scope");
    expect(conflicts[0]?.commandIds).toStrictEqual(["broad", "narrow"]);
  });

  it("compares two spellings of one keystroke against each other", () => {
    // Grouping by the chord string would miss this conflict.
    const { prepared } = prepareBindings([
      binding("$mod+k", "first"),
      binding("$mod+KeyK", "second"),
    ]);

    expect(detectConflicts(prepared)).toHaveLength(1);
  });

  it("treats an unproven disjointness as a conflict rather than as a pass", () => {
    // Fourteen distinct keys across the pair is over the enumeration bound of twelve, so
    // disjointness is unproven and counts as a conflict.
    const leftKeys = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"].join(" || ");
    const rightKeys = ["k8", "k9", "k10", "k11", "k12", "k13", "k14"].join(" || ");
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "left", leftKeys),
      binding("$mod+k", "right", rightKeys),
    ]);

    // Negative control: a clause that failed to parse would skip the overlap check entirely.
    expect(diagnostics).toStrictEqual([]);
    expect(detectConflicts(prepared)[0]?.reason).toBe("undecidable-scope");
  });
});
