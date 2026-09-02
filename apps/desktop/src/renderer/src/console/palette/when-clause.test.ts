// The fail-closed rule, held at the one place it can be broken: negation.
//
// The module header states that an unknown context key is FALSE. Read as a
// two-valued rule that sentence is self-defeating — substituting `false` for an
// absent key makes `!absentKey` TRUE, so a misspelled identifier does not hide a
// command, it reveals one, and the registry and the keybinding table both offer
// and run an act on a state nobody computed. Every case below is a clause whose
// answer differs between "absent means false" and "absent means unknown", plus
// the negative controls that keep the rule from being satisfied by an evaluator
// that simply answers `false` to everything.

import { describe, expect, it } from "vitest";

import { whenClausesCanOverlap } from "./when-clause-overlap.js";
import { parseWhenClause } from "./when-clause-parser.js";
import { evaluateWhenClause, type WhenClauseContext, type WhenClauseNode } from "./when-clause.js";

/** Parse a clause the way every caller does, and fail loudly if the source is bad. */
function clause(source: string): WhenClauseNode {
  const parsed = parseWhenClause(source);
  if (!parsed.ok) {
    throw new Error(`the test's own clause did not parse: ${source} — ${parsed.error.message}`);
  }
  return parsed.ast;
}

function evaluate(source: string, context: WhenClauseContext): boolean {
  return evaluateWhenClause(clause(source), context);
}

/** Everything the frame supplies in this suite. `sessionActve` is the typo. */
const SUPPLIED: WhenClauseContext = { sessionActive: true, onSettings: false };

describe("evaluateWhenClause — an unknown key stays unknown through every operator", () => {
  it("does not turn an absent key true by negating it", () => {
    // The finding, in one line: `!sessionActve` on a context that carries
    // `sessionActive` must not offer the command.
    expect(evaluate("!sessionActve", SUPPLIED)).toBe(false);
  });

  it("keeps a negated absent key false through a conjunction that is otherwise true", () => {
    expect(evaluate("!sessionActve && sessionActive", SUPPLIED)).toBe(false);
  });

  it("keeps a negated absent key false through a disjunction whose other arm is false", () => {
    expect(evaluate("!sessionActve || onSettings", SUPPLIED)).toBe(false);
  });

  it("survives double negation and parenthesised negation", () => {
    expect(evaluate("!!sessionActve", SUPPLIED)).toBe(false);
    expect(evaluate("!(sessionActve && sessionActive)", SUPPLIED)).toBe(false);
    expect(evaluate("!(sessionActve || onSettings)", SUPPLIED)).toBe(false);
  });

  it("answers false for a conjunction that names an absent key", () => {
    expect(evaluate("sessionActve && sessionActive", SUPPLIED)).toBe(false);
  });

  it("answers true for a disjunction a supplied key already decides", () => {
    // The unknown could not have changed this answer, so hiding the command
    // would be a refusal the clause does not ask for. This is the one arm where
    // an absent key still permits `true`, and it is the difference between
    // propagating the unknown and refusing the whole clause outright.
    expect(evaluate("sessionActve || sessionActive", SUPPLIED)).toBe(true);
  });

  it("answers false for a conjunction a supplied key already decides", () => {
    expect(evaluate("sessionActve && onSettings", SUPPLIED)).toBe(false);
  });

  it("treats a non-boolean that slipped past the type as unknown, not as false", () => {
    // A bridge boundary can hand over a string. Read as `false` it would flip
    // true under negation exactly the way an absent key did.
    const contaminated = { ...SUPPLIED, paneFocused: "yes" } as unknown as WhenClauseContext;
    expect(evaluateWhenClause(clause("paneFocused"), contaminated)).toBe(false);
    expect(evaluateWhenClause(clause("!paneFocused"), contaminated)).toBe(false);
  });

  it("negative control: a supplied key still negates, conjoins, and disjoins normally", () => {
    // Without this, an evaluator that answered `false` to every clause would
    // satisfy every case above and hide the whole palette.
    expect(evaluate("sessionActive", SUPPLIED)).toBe(true);
    expect(evaluate("!onSettings", SUPPLIED)).toBe(true);
    expect(evaluate("sessionActive && !onSettings", SUPPLIED)).toBe(true);
    expect(evaluate("onSettings || sessionActive", SUPPLIED)).toBe(true);
    expect(evaluate("sessionActive && onSettings", SUPPLIED)).toBe(false);
  });
});

describe("whenClausesCanOverlap — the conflict decision is unmoved", () => {
  it("still proves a clause and its negation disjoint, and an overlap an overlap", () => {
    // The overlap check enumerates a full assignment over the union of both
    // clauses' keys, so no identifier is ever absent inside it. The three-valued
    // evaluation must therefore leave every conflict verdict exactly as it was.
    expect(whenClausesCanOverlap(clause("paneFocused"), clause("!paneFocused"))).toBe("disjoint");
    expect(whenClausesCanOverlap(clause("sessionOpen"), clause("sessionOpen && paneFocused"))).toBe(
      "overlap",
    );
    expect(whenClausesCanOverlap(clause("sessionOpen"), undefined)).toBe("overlap");
  });
});
