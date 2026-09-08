// The `when` clause — the console's visibility language, and what one MEANS.
//
// `Spec-023 §Console Design (Meridian)` names it once, in the settings surface
// bullet: "a Keyboard page offers rebinding with conflict detection over the
// console's when-scoped chord grammar". This module is that scope language's
// TYPE and SEMANTICS — a parsed clause, what it evaluates to, which keys it
// reads, and how it prints. The syntax that produces one lives beside it in
// `when-clause-parser.ts`, the conflict question in `when-clause-overlap.ts`,
// and the per-source memo in `when-clause-cache.ts`.
//
// The clause is shared by the command registry (which commands are offered at
// all) and the keybinding table (which chord is live right now), which is why the
// evaluator is called from both rather than re-implemented in either: a keyboard
// scope that disagreed with a command's `when` about the same clause would make a
// chord fire a command the palette says is hidden.
//
// WHAT A CLAUSE IS NOT. There is no equality operator, no string literal, no
// `in`, no regular expression, no member call. Every one of those exists in the
// equivalent language of the editor this console is not copying, and every one of
// them turns a visibility predicate into a small programming language whose
// failure modes have to be specified. A context key is a boolean the frame
// computed; a clause combines them. That is the whole surface, and keeping it
// that small is what lets `whenClausesCanOverlap` decide conflicts by enumeration
// instead of by heuristics.
//
// THE FAIL-CLOSED RULE THIS MODULE OWNS: an UNKNOWN CONTEXT KEY IS UNKNOWN, and
// an unknown CLAUSE is false — never "assume true". A clause names the state
// under which a control is safe to offer. If the frame has not supplied that key,
// the console does not know whether the state holds — and `Spec-023 §Console
// Design (Meridian)`'s "Absent, not disabled" and "Fail-closed projection" rules
// both resolve an unknown to the conservative arm. Offering a control on a key
// nobody computed would be the renderer guessing at eligibility, which is
// precisely what that spec forbids. (The other fail-closed rule — a clause that
// does not parse hides its command — belongs to the parser and the cache, and is
// stated there.)
//
// WHY UNKNOWN IS A THIRD VALUE AND NOT JUST `false`. Substituting `false` for an
// absent key reads as fail-closed and is not: `!sessionActve` — one transposed
// letter — then evaluates TRUE, so a misspelled identifier does not hide a
// command, it reveals one, and both the registry and the keybinding table go on
// to offer and run an act on a state nobody computed. Negation is the operator
// that turns a conservative default into its opposite, so the unknown has to
// survive it. Evaluation is therefore three-valued (strong Kleene) INSIDE the
// module and two-valued at its boundary:
//
//   • `!unknown` is unknown         → `!absent` is FALSE
//   • `unknown && x` is false when `x` is false, unknown otherwise
//                                    → `absent && anything` is FALSE
//   • `unknown || x` is true when `x` is true, unknown otherwise
//                                    → `absent || knownTrue` is TRUE,
//                                      `absent || knownFalse` is FALSE
//   • an unknown clause collapses to `false` at {@link evaluateWhenClause}
//
// The one arm that still answers `true` is the disjunction a SUPPLIED key already
// decides, and that is the point of propagating rather than refusing outright:
// the unknown could not have changed the answer, so hiding the command would be a
// refusal the clause never asked for. The collapse is otherwise conservative
// rather than exact — evaluation is truth-functional, not a satisfiability check,
// so the pathological `x || !x` over an absent `x` is a tautology that still
// hides. Hiding a clause nobody should have written is the right side to err on.

/**
 * Context keys and their values.
 *
 * A key that is absent — and a value that is not a boolean, which is the same
 * thing once it has crossed a bridge boundary — is UNKNOWN, and a clause whose
 * answer depends on one is false. See the fail-closed rule in the file header.
 */
export type WhenClauseContext = Readonly<Record<string, boolean>>;

/** The parsed form of a clause. */
export type WhenClauseNode =
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "not"; readonly operand: WhenClauseNode }
  | { readonly kind: "and"; readonly left: WhenClauseNode; readonly right: WhenClauseNode }
  | { readonly kind: "or"; readonly left: WhenClauseNode; readonly right: WhenClauseNode };

/**
 * What a clause is worth when the context may not answer every key it names.
 *
 * Module-private: every caller outside this file asks a yes/no question about
 * whether to offer a control, and a third value escaping into the registry or the
 * keybinding table would be a second thing each of them had to decide.
 */
type WhenClauseTruth = boolean | "unknown";

/**
 * Evaluate a parsed clause.
 *
 * The boundary of the three-valued evaluation described in the file header: an
 * answer that depends on a key the context did not supply is `false` here, and a
 * caller therefore never sees the unknown.
 */
export function evaluateWhenClause(node: WhenClauseNode, context: WhenClauseContext): boolean {
  return resolveWhenClauseTruth(node, context) === true;
}

/**
 * Strong Kleene evaluation over the clause grammar.
 *
 * Written as explicit truth tables rather than with `&&` / `||` because
 * JavaScript's own operators are exactly what the two-valued version got wrong:
 * `"unknown"` is a truthy string, so `a && b` would answer `"unknown"` for a
 * conjunction one supplied `false` already decides, and `!a` would answer `false`
 * for a negation whose operand nobody computed.
 */
function resolveWhenClauseTruth(node: WhenClauseNode, context: WhenClauseContext): WhenClauseTruth {
  switch (node.kind) {
    case "identifier": {
      // Read once, and typed rather than compared against `true`: absent and
      // "present but not a boolean" are one case — the context does not answer
      // this key — and both must reach the unknown arm rather than the false one.
      const value = context[node.name];
      return typeof value === "boolean" ? value : "unknown";
    }
    case "not": {
      const operand = resolveWhenClauseTruth(node.operand, context);
      return operand === "unknown" ? "unknown" : !operand;
    }
    case "and": {
      // Short-circuits on the only value that decides a conjunction on its own.
      const left = resolveWhenClauseTruth(node.left, context);
      if (left === false) {
        return false;
      }
      const right = resolveWhenClauseTruth(node.right, context);
      if (right === false) {
        return false;
      }
      return left === "unknown" || right === "unknown" ? "unknown" : true;
    }
    case "or": {
      const left = resolveWhenClauseTruth(node.left, context);
      if (left === true) {
        return true;
      }
      const right = resolveWhenClauseTruth(node.right, context);
      if (right === true) {
        return true;
      }
      return left === "unknown" || right === "unknown" ? "unknown" : false;
    }
  }
}

/** Every context key the clause reads, sorted and de-duplicated. */
export function collectWhenClauseIdentifiers(node: WhenClauseNode): readonly string[] {
  const names = new Set<string>();
  const pending: WhenClauseNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    switch (current.kind) {
      case "identifier":
        names.add(current.name);
        break;
      case "not":
        pending.push(current.operand);
        break;
      case "and":
      case "or":
        pending.push(current.left, current.right);
        break;
    }
  }
  return [...names].sort();
}

/**
 * A canonical rendering of the clause, fully parenthesised at the operator
 * boundaries that matter. Used for diagnostics and for naming a scope in a
 * conflict report, so two spellings of one clause read identically to a person.
 */
export function formatWhenClause(node: WhenClauseNode): string {
  switch (node.kind) {
    case "identifier":
      return node.name;
    case "not": {
      const operand = formatWhenClause(node.operand);
      return node.operand.kind === "identifier" || node.operand.kind === "not"
        ? `!${operand}`
        : `!(${operand})`;
    }
    case "and":
      return `${formatWhenClauseOperand(node.left, "and")} && ${formatWhenClauseOperand(node.right, "and")}`;
    case "or":
      return `${formatWhenClauseOperand(node.left, "or")} || ${formatWhenClauseOperand(node.right, "or")}`;
  }
}

function formatWhenClauseOperand(node: WhenClauseNode, parentKind: "and" | "or"): string {
  const rendered = formatWhenClause(node);
  const needsParentheses = parentKind === "and" && node.kind === "or";
  return needsParentheses ? `(${rendered})` : rendered;
}
