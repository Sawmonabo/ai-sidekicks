// The `when` clause: the app's visibility language, its type and semantics. Syntax is in
// `when-clause-parser.ts`, conflict detection in `when-clause-overlap.ts`, the memo in
// `when-clause-cache.ts`. The command registry and the keybinding table both call the one
// evaluator, so a chord never fires a command the palette hides.
//
// A clause is boolean context keys combined with `!`, `&&`, `||` and parentheses. There is no
// equality, string, `in`, regex or call, which keeps the language small enough for
// `whenClausesCanOverlap` to decide conflicts by enumeration.
//
// Fail closed: a key the context does not supply is unknown, and an unknown clause is false.
// Unknown is a third value inside this module because substituting `false` would make a
// misspelled `!sessionActve` evaluate true and reveal a command. Evaluation is strong Kleene:
//
//   - `!unknown` is unknown
//   - `unknown && x` is false when `x` is false, otherwise unknown
//   - `unknown || x` is true when `x` is true, otherwise unknown
//   - an unknown result collapses to `false` in `evaluateWhenClause`
//
// Evaluation is truth-functional, not a satisfiability check, so `x || !x` over an absent `x`
// still hides; that is the safe side to err on.

/** Context keys and values; an absent key or a non-boolean value is unknown. */
export type WhenClauseContext = Readonly<Record<string, boolean>>;

/** The parsed form of a clause. */
export type WhenClauseNode =
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "not"; readonly operand: WhenClauseNode }
  | { readonly kind: "and"; readonly left: WhenClauseNode; readonly right: WhenClauseNode }
  | { readonly kind: "or"; readonly left: WhenClauseNode; readonly right: WhenClauseNode };

/** Evaluates a parsed clause; an answer that depends on an unsupplied key is `false`. */
export function evaluateWhenClause(node: WhenClauseNode, context: WhenClauseContext): boolean {
  return resolveWhenClauseTruth(node, context) === true;
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

/** A canonical rendering for diagnostics and conflict reports. */
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

/** Module-private so callers only ever see a yes/no answer. */
type WhenClauseTruth = boolean | "unknown";

/** Strong Kleene evaluation, written as explicit tables because `"unknown"` is a truthy string. */
function resolveWhenClauseTruth(node: WhenClauseNode, context: WhenClauseContext): WhenClauseTruth {
  switch (node.kind) {
    case "identifier": {
      // Absent and non-boolean are one case: the context does not answer this key.
      const value = context[node.name];
      return typeof value === "boolean" ? value : "unknown";
    }
    case "not": {
      const operand = resolveWhenClauseTruth(node.operand, context);
      return operand === "unknown" ? "unknown" : !operand;
    }
    case "and": {
      // `false` alone decides a conjunction.
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

function formatWhenClauseOperand(node: WhenClauseNode, parentKind: "and" | "or"): string {
  const rendered = formatWhenClause(node);
  const needsParentheses = parentKind === "and" && node.kind === "or";
  return needsParentheses ? `(${rendered})` : rendered;
}
