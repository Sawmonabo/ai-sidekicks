// What a candidate binding set answers before it is installed.
//
// `prepareBindings` and `detectConflicts` are the pre-flight half of the binding
// table: the Keyboard settings page calls them through `KeyBindingTable.conflictsIn`
// to show a person what a set WOULD do, and `setBindings` calls the same pair to
// decide what it does. That shared path is the reason they are worth their own
// file — a preview that validated differently from the commit would be a second
// source of truth for one question, and the failure is silent in both directions.
//
// The conflict REPORT is tested here too, not just the verdict. A conflict a
// person cannot read is a conflict they cannot fix, and the report is the only
// thing they see: `setBindings` throws, the table stays as it was, and the message
// is the whole of what happened.

import { describe, expect, it } from "vitest";

import { detectConflicts, prepareBindings } from "./keybinding-conflicts.js";
import type { KeyBinding } from "./contributions.js";

/** One binding, spelled out so each test names only what it is about. */
function binding(chord: string, commandId: string, when?: string): KeyBinding {
  return when === undefined ? { chord, commandId } : { chord, commandId, when };
}

describe("prepareBindings — which rows are well formed at all", () => {
  it("drops a multi-press sequence and says which row and why", () => {
    // A sequence needs a pending-press map behind a timeout, and the console runs
    // no timer on its input path. Refusing at install is the whole point: the
    // alternative is a binding that looks installed and never fires.
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "palette.open"),
      binding("g d", "goto.definition"),
    ]);

    expect(prepared.map((entry) => entry.binding.commandId)).toStrictEqual(["palette.open"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe("chord-unparseable");
    expect(diagnostics[0]?.binding.commandId).toBe("goto.definition");
  });

  it("drops a scope that does not parse, and does not drop the rest of the set", () => {
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "palette.open"),
      binding("$mod+j", "jump.next", "sessionOpen &&"),
    ]);

    expect(prepared.map((entry) => entry.binding.commandId)).toStrictEqual(["palette.open"]);
    expect(diagnostics[0]?.reason).toBe("when-unparseable");
  });

  it("records specificity as the count of DISTINCT keys the scope names", () => {
    // Specificity is the dispatch tie-break, so it has to count keys rather than
    // terms: `a && a` names one key however many times it is written, and reading
    // it as two would make a repeated identifier beat a genuinely narrower scope.
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
    // The real definition of a conflict is "both can be live at one moment", not
    // "the two clauses are spelled the same". This pair is the case a string
    // comparison would miss.
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
    // `$mod+k` and `$mod+KeyK` are one chord. Grouping by the chord STRING would
    // put them in different buckets and report no conflict at all.
    const { prepared } = prepareBindings([
      binding("$mod+k", "first"),
      binding("$mod+KeyK", "second"),
    ]);

    expect(detectConflicts(prepared)).toHaveLength(1);
  });

  it("treats an unproven disjointness as a conflict rather than as a pass", () => {
    // Past the enumeration bound the answer is not "no conflict", it is "not
    // proven" — and a silently shadowed keybinding is worse than a refused install
    // a person can see. Fourteen distinct keys across the pair is over the bound of
    // twelve; the depth bound is untouched, since a flat chain nests one level.
    const leftKeys = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"].join(" || ");
    const rightKeys = ["k8", "k9", "k10", "k11", "k12", "k13", "k14"].join(" || ");
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "left", leftKeys),
      binding("$mod+k", "right", rightKeys),
    ]);

    // The negative control for the assertion below: if either clause had failed to
    // parse, the pair would never reach the overlap check and the test would report
    // "no conflict" for entirely the wrong reason.
    expect(diagnostics).toStrictEqual([]);
    expect(detectConflicts(prepared)[0]?.reason).toBe("undecidable-scope");
  });
});

describe("the conflict report — one clause reads one way", () => {
  it("names the canonical rendering, not the author's spelling", () => {
    // `a&&b` and `a && b` are one clause typed two ways. Quoting the sources back
    // would print a report that names two different-looking scopes and then calls
    // them overlapping, which reads as a bug in the checker rather than as a
    // conflict in the bindings.
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "tight", "sessionOpen&&paneFocused"),
      binding("$mod+k", "loose", "sessionOpen && paneFocused"),
    ]);
    expect(diagnostics).toStrictEqual([]);

    const detail = detectConflicts(prepared)[0]?.detail ?? "";
    expect(detail).toContain("(sessionOpen && paneFocused and sessionOpen && paneFocused)");

    // The negative control, and it is the whole test: the two SOURCE strings differ,
    // so a report built from `binding.when` could not have produced the line above.
    // Without this the assertion would also pass if both clauses were rendered from
    // source and merely happened to match.
    expect("sessionOpen&&paneFocused").not.toBe("sessionOpen && paneFocused");
  });

  it("canonicalises a redundantly parenthesised negation the same way", () => {
    const { prepared, diagnostics } = prepareBindings([
      binding("$mod+k", "parenthesised", "!(paneFocused)"),
      binding("$mod+k", "bare", "!paneFocused"),
    ]);
    expect(diagnostics).toStrictEqual([]);

    expect(detectConflicts(prepared)[0]?.detail).toContain("(!paneFocused and !paneFocused)");
  });

  it("calls an absent scope `always` rather than printing nothing", () => {
    // An empty parenthesis in the message would read as a rendering failure. The
    // unscoped binding has the widest scope there is, and the report says so.
    const { prepared } = prepareBindings([
      binding("$mod+k", "unscoped"),
      binding("$mod+k", "scoped", "paneFocused"),
    ]);

    expect(detectConflicts(prepared)[0]?.detail).toContain("(always and paneFocused)");
  });
});
