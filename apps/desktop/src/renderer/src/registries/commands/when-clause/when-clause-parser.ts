// The `when` grammar: text in, a `WhenClauseNode` or a parse error out.
//
// The grammar, in full:
//
//   expression  := disjunction
//   disjunction := conjunction ( "||" conjunction )*
//   conjunction := unary       ( "&&" unary )*
//   unary       := "!" unary | primary
//   primary     := identifier | "(" expression ")"
//   identifier  := [A-Za-z_] [A-Za-z0-9_.]*
//
// A clause that does not parse hides its command: it does not throw (one malformed clause must
// not take the palette down) and does not default to visible. The error is returned as a value.
//
// `WHEN_CLAUSE_MAX_DEPTH` bounds nesting, not length: `a && b && c` parses iteratively, while
// `((((` and `!!!!` recurse and are refused past the bound so a hostile clause cannot overflow
// the stack inside a visibility check.

import { WHEN_CLAUSE_MAX_DEPTH } from "@renderer/styles/palette.js";
import type { WhenClauseNode } from "./when-clause.js";

/** Why a clause did not parse. */
export type WhenClauseParseErrorKind =
  | "empty-clause"
  | "unexpected-character"
  | "unexpected-token"
  | "unterminated-group"
  | "max-depth-exceeded";

/** A parse failure, as a value. Never thrown: the caller decides what to render. */
export interface WhenClauseParseError {
  readonly kind: WhenClauseParseErrorKind;
  /** User-facing, sentence case, no trailing period. */
  readonly message: string;
  /** Zero-based index into `source` where the failure was detected. */
  readonly position: number;
  readonly source: string;
}

/** Either a parsed clause or the reason there is none. */
export type WhenClauseParseResult =
  | { readonly ok: true; readonly ast: WhenClauseNode }
  | { readonly ok: false; readonly error: WhenClauseParseError };

/** Parses a clause. Never throws; a failure is the `ok: false` arm. */
export function parseWhenClause(source: string): WhenClauseParseResult {
  const tokenized = tokenizeWhenClause(source);
  if (!tokenized.ok) {
    return tokenized;
  }
  return new WhenClauseParser(source, tokenized.tokens).parse();
}

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
      // A single `&` or `|` is refused rather than accepted as an alias of the doubled operator.
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

/** Recursive-descent parser state; the cursor and depth are private to the parse. */
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
