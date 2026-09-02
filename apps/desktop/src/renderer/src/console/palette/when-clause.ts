// The `when` grammar — the console's visibility language.
//
// `Spec-023 §Console Design (Meridian)` names it once, in the settings surface
// bullet: "a Keyboard page offers rebinding with conflict detection over the
// console's when-scoped chord grammar". This module is that scope language, and
// it is shared by the command registry (which commands are offered at all) and
// the keybinding table (which chord is live right now).
//
// THE GRAMMAR, in full:
//
//   expression  := disjunction
//   disjunction := conjunction ( "||" conjunction )*
//   conjunction := unary       ( "&&" unary )*
//   unary       := "!" unary | primary
//   primary     := identifier | "(" expression ")"
//   identifier  := [A-Za-z_] [A-Za-z0-9_.]*
//
// There is no equality operator, no string literal, no `in`, no regular
// expression, no member call. Every one of those exists in the equivalent
// language of the editor this console is not copying, and every one of them
// turns a visibility predicate into a small programming language whose failure
// modes have to be specified. A context key is a boolean the frame computed; a
// clause combines them. That is the whole surface, and keeping it that small is
// what lets `whenClausesCanOverlap` below decide conflicts by enumeration
// instead of by heuristics.
//
// TWO RULES, BOTH FAIL-CLOSED:
//
//   1. An UNKNOWN CONTEXT KEY IS FALSE, never undefined and never "assume true".
//      A clause names the state under which a control is safe to offer. If the
//      frame has not supplied that key, the console does not know whether the
//      state holds — and `Spec-023 §Console Design (Meridian)`'s "Absent, not
//      disabled" and "Fail-closed projection" rules both resolve an unknown to
//      the conservative arm. Offering a control on a key nobody computed would
//      be the renderer guessing at eligibility, which is precisely what that
//      spec forbids.
//   2. A CLAUSE THAT DOES NOT PARSE HIDES ITS COMMAND. It does not throw (one
//      malformed rebinding must not take the palette down with it) and it does
//      not fall back to "always visible" (that turns a typo into an unguarded
//      control). It hides, and the parse error is returned as a value so the
//      registry can surface it as the `error` kind of nothing rather than as
//      silence.
//
// BOUNDED DEPTH. `WHEN_CLAUSE_MAX_DEPTH` bounds NESTING, not length: `a && b &&
// c && …` parses iteratively and is unbounded, while `((((…))))` and `!!!!…`
// recurse and are refused past the bound. Recursion is where a hostile or
// generated clause could exhaust the stack, and a stack overflow inside a
// visibility check would fail OPEN in the worst way — by crashing the surface
// that was deciding what to hide.

import { WHEN_CLAUSE_MAX_DEPTH } from "../core/index.js";

/** Context keys and their values. A key that is absent evaluates false. */
export type WhenClauseContext = Readonly<Record<string, boolean>>;

/** The parsed form of a clause. */
export type WhenClauseNode =
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "not"; readonly operand: WhenClauseNode }
  | { readonly kind: "and"; readonly left: WhenClauseNode; readonly right: WhenClauseNode }
  | { readonly kind: "or"; readonly left: WhenClauseNode; readonly right: WhenClauseNode };

/** Why a clause did not parse. Closed — every arm renders its own copy. */
export type WhenClauseParseErrorKind =
  | "empty-clause"
  | "unexpected-character"
  | "unexpected-token"
  | "unterminated-group"
  | "max-depth-exceeded";

/** A parse failure, as a value. Never thrown: the caller decides what to render. */
export interface WhenClauseParseError {
  readonly kind: WhenClauseParseErrorKind;
  /** Operator-facing, sentence case, no trailing period — console copy rules. */
  readonly message: string;
  /** Zero-based index into `source` where the failure was detected. */
  readonly position: number;
  readonly source: string;
}

/** Either a clause or the reason there is not one. */
export type WhenClauseParseResult =
  | { readonly ok: true; readonly ast: WhenClauseNode }
  | { readonly ok: false; readonly error: WhenClauseParseError };

type WhenClauseTokenKind =
  | "identifier"
  | "not"
  | "and"
  | "or"
  | "open-parenthesis"
  | "close-parenthesis";

interface WhenClauseToken {
  readonly kind: WhenClauseTokenKind;
  readonly text: string;
  readonly position: number;
}

type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly WhenClauseToken[] }
  | { readonly ok: false; readonly error: WhenClauseParseError };

function parseError(
  kind: WhenClauseParseErrorKind,
  message: string,
  position: number,
  source: string,
): WhenClauseParseError {
  return { kind, message, position, source };
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    character === "_"
  );
}

function isIdentifierPart(character: string): boolean {
  return (
    isIdentifierStart(character) || (character >= "0" && character <= "9") || character === "."
  );
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function tokenizeWhenClause(source: string): TokenizeResult {
  const tokens: WhenClauseToken[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const character = source.charAt(cursor);

    if (isWhitespace(character)) {
      cursor += 1;
      continue;
    }

    if (character === "(") {
      tokens.push({ kind: "open-parenthesis", text: "(", position: cursor });
      cursor += 1;
      continue;
    }

    if (character === ")") {
      tokens.push({ kind: "close-parenthesis", text: ")", position: cursor });
      cursor += 1;
      continue;
    }

    if (character === "!") {
      tokens.push({ kind: "not", text: "!", position: cursor });
      cursor += 1;
      continue;
    }

    if (character === "&" || character === "|") {
      // Single `&` and `|` are refused rather than accepted as aliases: a person
      // who typed one meant the doubled operator, and silently accepting the
      // typo would make the two spellings drift apart in every later reader.
      if (source.charAt(cursor + 1) !== character) {
        return {
          ok: false,
          error: parseError(
            "unexpected-character",
            `The clause uses "${character}"; the operators are "&&" and "||"`,
            cursor,
            source,
          ),
        };
      }
      tokens.push({
        kind: character === "&" ? "and" : "or",
        text: `${character}${character}`,
        position: cursor,
      });
      cursor += 2;
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length && isIdentifierPart(source.charAt(cursor))) {
        cursor += 1;
      }
      tokens.push({ kind: "identifier", text: source.slice(start, cursor), position: start });
      continue;
    }

    return {
      ok: false,
      error: parseError(
        "unexpected-character",
        `The clause contains "${character}", which is not part of the when grammar`,
        cursor,
        source,
      ),
    };
  }

  return { ok: true, tokens };
}

/**
 * Recursive-descent parser state.
 *
 * A class rather than a closure over a mutable cursor: the cursor and the depth
 * counter are the parse, and putting them behind `#` makes it structurally
 * impossible for one production to rewind another's position by accident.
 */
class WhenClauseParser {
  readonly #source: string;
  readonly #tokens: readonly WhenClauseToken[];
  #cursor = 0;
  #depth = 0;

  public constructor(source: string, tokens: readonly WhenClauseToken[]) {
    this.#source = source;
    this.#tokens = tokens;
  }

  public parse(): WhenClauseParseResult {
    if (this.#tokens.length === 0) {
      return {
        ok: false,
        error: parseError("empty-clause", "The clause is empty", 0, this.#source),
      };
    }
    const expression = this.#parseExpression();
    if (!expression.ok) {
      return expression;
    }
    const trailing = this.#peek();
    if (trailing !== undefined) {
      return {
        ok: false,
        error: parseError(
          "unexpected-token",
          `The clause continues with "${trailing.text}" where it should have ended`,
          trailing.position,
          this.#source,
        ),
      };
    }
    return expression;
  }

  #peek(): WhenClauseToken | undefined {
    return this.#tokens[this.#cursor];
  }

  #take(): WhenClauseToken | undefined {
    const token = this.#tokens[this.#cursor];
    if (token !== undefined) {
      this.#cursor += 1;
    }
    return token;
  }

  #endPosition(): number {
    const lastToken = this.#tokens[this.#tokens.length - 1];
    return lastToken === undefined ? 0 : lastToken.position + lastToken.text.length;
  }

  #depthExceeded(position: number): WhenClauseParseResult {
    return {
      ok: false,
      error: parseError(
        "max-depth-exceeded",
        `The clause nests deeper than ${String(WHEN_CLAUSE_MAX_DEPTH)} levels`,
        position,
        this.#source,
      ),
    };
  }

  /** `disjunction := conjunction ( "||" conjunction )*`, left-associated. */
  #parseExpression(): WhenClauseParseResult {
    this.#depth += 1;
    if (this.#depth > WHEN_CLAUSE_MAX_DEPTH) {
      const token = this.#peek();
      this.#depth -= 1;
      return this.#depthExceeded(token === undefined ? this.#endPosition() : token.position);
    }

    let left = this.#parseConjunction();
    while (left.ok) {
      const operator = this.#peek();
      if (operator === undefined || operator.kind !== "or") {
        break;
      }
      this.#take();
      const right = this.#parseConjunction();
      if (!right.ok) {
        left = right;
        break;
      }
      left = { ok: true, ast: { kind: "or", left: left.ast, right: right.ast } };
    }

    this.#depth -= 1;
    return left;
  }

  /** `conjunction := unary ( "&&" unary )*`, left-associated. */
  #parseConjunction(): WhenClauseParseResult {
    let left = this.#parseUnary();
    while (left.ok) {
      const operator = this.#peek();
      if (operator === undefined || operator.kind !== "and") {
        break;
      }
      this.#take();
      const right = this.#parseUnary();
      if (!right.ok) {
        return right;
      }
      left = { ok: true, ast: { kind: "and", left: left.ast, right: right.ast } };
    }
    return left;
  }

  /** `unary := "!" unary | primary`. `!` chains recurse, so they count toward depth. */
  #parseUnary(): WhenClauseParseResult {
    const token = this.#peek();
    if (token !== undefined && token.kind === "not") {
      this.#depth += 1;
      if (this.#depth > WHEN_CLAUSE_MAX_DEPTH) {
        this.#depth -= 1;
        return this.#depthExceeded(token.position);
      }
      this.#take();
      const operand = this.#parseUnary();
      this.#depth -= 1;
      if (!operand.ok) {
        return operand;
      }
      return { ok: true, ast: { kind: "not", operand: operand.ast } };
    }
    return this.#parsePrimary();
  }

  /** `primary := identifier | "(" expression ")"`. */
  #parsePrimary(): WhenClauseParseResult {
    const token = this.#take();
    if (token === undefined) {
      return {
        ok: false,
        error: parseError(
          "unexpected-token",
          "The clause ends where a context key was expected",
          this.#endPosition(),
          this.#source,
        ),
      };
    }

    if (token.kind === "identifier") {
      return { ok: true, ast: { kind: "identifier", name: token.text } };
    }

    if (token.kind === "open-parenthesis") {
      const inner = this.#parseExpression();
      if (!inner.ok) {
        return inner;
      }
      const closing = this.#peek();
      if (closing === undefined || closing.kind !== "close-parenthesis") {
        return {
          ok: false,
          error: parseError(
            "unterminated-group",
            'A group opened with "(" is never closed',
            token.position,
            this.#source,
          ),
        };
      }
      this.#take();
      return inner;
    }

    return {
      ok: false,
      error: parseError(
        "unexpected-token",
        `The clause has "${token.text}" where a context key was expected`,
        token.position,
        this.#source,
      ),
    };
  }
}

/** Parse a clause. Never throws; a failure is the `ok: false` arm. */
export function parseWhenClause(source: string): WhenClauseParseResult {
  const tokenized = tokenizeWhenClause(source);
  if (!tokenized.ok) {
    return tokenized;
  }
  return new WhenClauseParser(source, tokenized.tokens).parse();
}

/**
 * Evaluate a parsed clause.
 *
 * A key the context does not carry is FALSE — see rule 1 in the file header. The
 * `=== true` comparison (rather than a truthiness test) is what enforces it, and
 * it also refuses a non-boolean that slipped past the type at a bridge boundary.
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

/**
 * How many distinct context keys a pair of clauses may name before
 * `whenClausesCanOverlap` stops enumerating.
 *
 * Twelve keys is 4096 assignments per pair, checked only for bindings that share
 * a chord — microseconds, once, at install. It is set by what a human writes: a
 * console clause names two or three keys, and a pair naming thirteen is a design
 * smell long before it is a performance problem.
 */
export const WHEN_CLAUSE_OVERLAP_MAX_CONTEXT_KEYS = 12;

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

/**
 * Parsed clauses, keyed by source text.
 *
 * The palette re-evaluates every command's clause on every keystroke, so parsing
 * per evaluation would re-tokenize the same handful of strings thousands of times
 * across a session. The cache is also what keeps the development-mode warning
 * honest: a broken clause warns ONCE, when it is first compiled, instead of once
 * per character typed.
 */
export class WhenClauseCache {
  readonly #results = new Map<string, WhenClauseParseResult>();

  /** Parse `source`, or return the previously parsed result for it. */
  public compile(source: string): WhenClauseParseResult {
    const cached = this.#results.get(source);
    if (cached !== undefined) {
      return cached;
    }
    const result = parseWhenClause(source);
    this.#results.set(source, result);
    if (!result.ok && import.meta.env.DEV) {
      // Development only, and `warn` rather than `throw`: the console must still
      // render with one bad clause in it, and the hidden command IS the
      // production signal (the registry reports the same error as the `error`
      // kind of nothing). This line exists so the author sees it sooner.
      console.warn(
        `when-clause did not parse and its command is hidden: ${source} — ${result.error.message} (at ${String(result.error.position)})`,
      );
    }
    return result;
  }

  /**
   * Evaluate a clause source against a context.
   *
   * `undefined` source means "no clause", which is always true — an unconditional
   * command. A clause that does not parse is FALSE, which hides its command.
   */
  public evaluate(source: string | undefined, context: WhenClauseContext): boolean {
    if (source === undefined) {
      return true;
    }
    const result = this.compile(source);
    return result.ok ? evaluateWhenClause(result.ast, context) : false;
  }

  /** The parsed clause, or `undefined` when it did not parse. */
  public astFor(source: string): WhenClauseNode | undefined {
    const result = this.compile(source);
    return result.ok ? result.ast : undefined;
  }

  /** Every clause that failed to parse, for the surfaces that render refusals. */
  public errors(): readonly WhenClauseParseError[] {
    const errors: WhenClauseParseError[] = [];
    for (const result of this.#results.values()) {
      if (!result.ok) {
        errors.push(result.error);
      }
    }
    return errors;
  }

  /** Drop every cached parse. Used when a settings page rewrites the clause set. */
  public clear(): void {
    this.#results.clear();
  }
}
