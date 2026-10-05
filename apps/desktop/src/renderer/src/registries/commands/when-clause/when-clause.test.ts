// The fail-closed rule at the place it can break: negation. Treating an absent key as
// `false` would make `!absentKey` true and reveal a command, so each case differs between
// "absent means false" and "absent means unknown".

import { describe, expect, it } from "vitest";

import { parseWhenClause } from "./parser.js";
import { evaluateWhenClause, type WhenClauseContext, type WhenClauseNode } from "./when-clause.js";

/** Parses a clause the way every caller does and throws if the source is bad. */
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
    // A typo, `!sessionActve`, on a context carrying `sessionActive` must not offer the command.
    expect(evaluate("!sessionActve", SUPPLIED)).toBe(false);
  });

  it("keeps a negated absent key false through a conjunction that is otherwise true", () => {
    expect(evaluate("!sessionActve && sessionActive", SUPPLIED)).toBe(false);
  });

  it("keeps a negated absent key false through a disjunction whose other arm is false", () => {
    expect(evaluate("!sessionActve || onSettings", SUPPLIED)).toBe(false);
  });

  it("survives double negation and parenthesized negation", () => {
    expect(evaluate("!!sessionActve", SUPPLIED)).toBe(false);
    expect(evaluate("!(sessionActve && sessionActive)", SUPPLIED)).toBe(false);
    expect(evaluate("!(sessionActve || onSettings)", SUPPLIED)).toBe(false);
  });

  it("treats a non-boolean that slipped past the type as unknown, not as false", () => {
    // A bridge can hand over a string; read as `false` it would flip true under negation.
    const contaminated = { ...SUPPLIED, paneFocused: "yes" } as unknown as WhenClauseContext;
    expect(evaluateWhenClause(clause("paneFocused"), contaminated)).toBe(false);
    expect(evaluateWhenClause(clause("!paneFocused"), contaminated)).toBe(false);
  });
});
