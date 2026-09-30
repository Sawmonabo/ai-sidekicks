// The pre-flight half of the binding table: `prepareBindings` and `detectConflicts` back both the
// settings page preview and `setBindings`. The conflict report is tested too, since it is all a
// person sees when `setBindings` throws.

import { describe, expect, it } from "vitest";

import { detectConflicts, prepareBindings } from "./keybinding-conflicts.js";
import type { Keybinding } from "../commands/command-types.js";

/** One binding, so each test names only what it is about. */
function binding(chord: string, commandId: string, when?: string): Keybinding {
  return when === undefined ? { chord, commandId } : { chord, commandId, when };
}

describe("prepareBindings — which rows are well formed at all", () => {
  it("drops a multi-press sequence and says which row and why", () => {
    // A sequence needs a pending-press timer; refusing at install avoids a binding that never
    // fires.
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+Shift+p", "palette.open"),
      binding("g d", "goto.definition"),
    ]);

    expect(prepared.map((entry) => entry.binding.commandId)).toStrictEqual(["palette.open"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe("chord-unparseable");
    expect(diagnostics[0]?.binding.commandId).toBe("goto.definition");
  });

  it("drops a scope that does not parse, and does not drop the rest of the set", () => {
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+Shift+p", "palette.open"),
      binding("$mod+j", "jump.next", "sessionOpen &&"),
    ]);

    expect(prepared.map((entry) => entry.binding.commandId)).toStrictEqual(["palette.open"]);
    expect(diagnostics[0]?.reason).toBe("when-unparseable");
  });

  it("records specificity as the count of DISTINCT keys the scope names", () => {
    // Specificity counts keys, not terms: `a && a` names one key.
    const { prepared } = prepareBindings([
      binding("$mod+1", "none"),
      binding("$mod+2", "one", "sessionOpen"),
      binding("$mod+3", "repeated", "sessionOpen && sessionOpen"),
      binding("$mod+4", "two", "sessionOpen && paneFocused"),
    ]);

    expect(prepared.map((entry) => entry.specificity)).toStrictEqual([0, 1, 1, 2]);
  });
});

describe("detectConflicts — which surviving pairs can fire on one keystroke", () => {
  it("finds no conflict between scopes that cannot both be true", () => {
    const { prepared } = prepareBindings([
      binding("$mod+k", "focus.pane", "paneFocused"),
      binding("$mod+k", "focus.rail", "!paneFocused"),
    ]);

    expect(detectConflicts(prepared)).toStrictEqual([]);
  });

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

describe("the conflict report — one clause reads one way", () => {
  it("names the canonical rendering, not the author's spelling", () => {
    // `a&&b` and `a && b` are one clause; quoting sources would look like two scopes.
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "tight", "sessionOpen&&paneFocused"),
      binding("$mod+k", "loose", "sessionOpen && paneFocused"),
    ]);
    expect(diagnostics).toStrictEqual([]);

    const detail = detectConflicts(prepared)[0]?.detail ?? "";
    expect(detail).toContain("(sessionOpen && paneFocused and sessionOpen && paneFocused)");

    // The source strings differ, so a report built from `binding.when` could not match above.
    expect("sessionOpen&&paneFocused").not.toBe("sessionOpen && paneFocused");
  });

  it("canonicalizes a redundantly parenthesized negation the same way", () => {
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "parenthesized", "!(paneFocused)"),
      binding("$mod+k", "bare", "!paneFocused"),
    ]);
    expect(diagnostics).toStrictEqual([]);

    expect(detectConflicts(prepared)[0]?.detail).toContain("(!paneFocused and !paneFocused)");
  });

  it("calls an absent scope `always` rather than printing nothing", () => {
    // An empty parenthesis would read as a rendering failure.
    const { prepared } = prepareBindings([
      binding("$mod+k", "unscoped"),
      binding("$mod+k", "scoped", "paneFocused"),
    ]);

    expect(detectConflicts(prepared)[0]?.detail).toContain("(always and paneFocused)");
  });
});
