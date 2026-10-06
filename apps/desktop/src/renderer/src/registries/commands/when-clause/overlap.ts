// Can two `when` scopes be true at the same time? A decision procedure over the semantics
// in `semantics.ts`, run once per chord collision at install time, never on the input path.

import {
  collectWhenClauseIdentifiers,
  evaluateWhenClause,
  type WhenClauseNode,
} from "./semantics.js";

/**
 * Distinct context keys a pair of clauses may name before the check stops enumerating. Twelve
 * keys is 4096 assignments per pair, checked once at install and only for bindings that share a
 * chord; a clause names two or three keys.
 */
const WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS = 12;

/** What `whenClausesCanOverlap` could establish about two scopes. */
export type WhenClauseOverlap = "overlap" | "disjoint" | "undecided";

/**
 * Whether two clauses can be true at the same time, which is what makes two bindings conflict.
 * `sessionOpen` and `sessionOpen && paneFocused` collide; `paneFocused` and `!paneFocused` do
 * not. Enumerating the union of their keys is exact because the grammar is only booleans.
 * `undefined` is the always-true scope. Past the key bound the answer is `"undecided"`, which
 * callers treat as a conflict: a silently shadowed binding is worse than a visible refusal.
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
