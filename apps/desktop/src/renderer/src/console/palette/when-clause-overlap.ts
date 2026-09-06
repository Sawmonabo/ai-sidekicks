// Can two `when` scopes be true at the same time?
//
// This is the one question the keybinding table asks about a PAIR of clauses
// rather than about one, and it is separated from both the parser and the
// evaluator because it is neither: it is a decision procedure OVER the semantics
// `when-clause.ts` defines, run once per chord collision at install time and
// never on the input path.

import { WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS } from "../core/index.js";
import {
  collectWhenClauseIdentifiers,
  evaluateWhenClause,
  type WhenClauseNode,
} from "./when-clause.js";

/** What `whenClausesCanOverlap` could establish about two scopes. */
export type WhenClauseOverlap = "overlap" | "disjoint" | "undecided";

/**
 * Can two clauses be true at the same time?
 *
 * This is the real definition of a keybinding conflict — not "the two clauses
 * are spelled the same". `sessionOpen` and `sessionOpen && paneFocused` are
 * spelled differently and still collide; `paneFocused` and `!paneFocused` are
 * both non-empty scopes on one chord and never collide. Deciding it by
 * enumeration over the union of their keys is exact for this grammar, because
 * the grammar has nothing in it but booleans, and it is affordable because the
 * key count is bounded above.
 *
 * `undefined` means "no clause", which is the always-true scope.
 *
 * Past the bound the answer is `"undecided"`, and the caller treats that as a
 * conflict: an unproven disjointness is not a proof, and a silently shadowed
 * keybinding is worse than a refused install a person can see.
 */
export function whenClausesCanOverlap(
  left: WhenClauseNode | undefined,
  right: WhenClauseNode | undefined,
): WhenClauseOverlap {
  if (left === undefined || right === undefined) {
    return "overlap";
  }

  const keys = [
    ...new Set([...collectWhenClauseIdentifiers(left), ...collectWhenClauseIdentifiers(right)]),
  ].sort();
  if (keys.length > WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS) {
    return "undecided";
  }

  const assignmentCount = 2 ** keys.length;
  for (let assignment = 0; assignment < assignmentCount; assignment += 1) {
    const context: Record<string, boolean> = {};
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];
      if (key !== undefined) {
        context[key] = (assignment & (1 << keyIndex)) !== 0;
      }
    }
    if (evaluateWhenClause(left, context) && evaluateWhenClause(right, context)) {
      return "overlap";
    }
  }
  return "disjoint";
}
