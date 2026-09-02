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
// THE FAIL-CLOSED RULE THIS MODULE OWNS: an UNKNOWN CONTEXT KEY IS FALSE, never
// undefined and never "assume true". A clause names the state under which a
// control is safe to offer. If the frame has not supplied that key, the console
// does not know whether the state holds — and `Spec-023 §Console Design
// (Meridian)`'s "Absent, not disabled" and "Fail-closed projection" rules both
// resolve an unknown to the conservative arm. Offering a control on a key nobody
// computed would be the renderer guessing at eligibility, which is precisely what
// that spec forbids. (The other fail-closed rule — a clause that does not parse
// hides its command — belongs to the parser and the cache, and is stated there.)

/** Context keys and their values. A key that is absent evaluates false. */
export type WhenClauseContext = Readonly<Record<string, boolean>>;

/** The parsed form of a clause. */
export type WhenClauseNode =
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "not"; readonly operand: WhenClauseNode }
  | { readonly kind: "and"; readonly left: WhenClauseNode; readonly right: WhenClauseNode }
  | { readonly kind: "or"; readonly left: WhenClauseNode; readonly right: WhenClauseNode };

/**
 * Evaluate a parsed clause.
 *
 * A key the context does not carry is FALSE — see the fail-closed rule in the
 * file header. The `=== true` comparison (rather than a truthiness test) is what
 * enforces it, and it also refuses a non-boolean that slipped past the type at a
 * bridge boundary.
 */
export function evaluateWhenClause(node: WhenClauseNode, context: WhenClauseContext): boolean {
  switch (node.kind) {
    case "identifier":
      return context[node.name] === true;
    case "not":
      return !evaluateWhenClause(node.operand, context);
    case "and":
      return evaluateWhenClause(node.left, context) && evaluateWhenClause(node.right, context);
    case "or":
      return evaluateWhenClause(node.left, context) || evaluateWhenClause(node.right, context);
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
