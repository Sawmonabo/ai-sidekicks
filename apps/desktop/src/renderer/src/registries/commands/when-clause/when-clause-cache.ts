// Parsed clauses keyed by source text. The palette re-evaluates every clause on each
// keystroke, and a broken clause warns once when first compiled, not per character.

import { evaluateWhenClause, type WhenClauseContext } from "./when-clause.js";
import { parseWhenClause, type WhenClauseParseResult } from "./when-clause-parser.js";

/** A memo over `parseWhenClause`, one instance per command registry. */
export class WhenClauseCache {
  readonly #results = new Map<string, WhenClauseParseResult>();

  /** Parses `source`, or returns the previously parsed result. */
  public compile(source: string): WhenClauseParseResult {
    const cached = this.#results.get(source);
    if (cached !== undefined) {
      return cached;
    }
    const result = parseWhenClause(source);
    this.#results.set(source, result);
    if (!result.ok && import.meta.env.DEV) {
      // `warn`, not `throw`: the console must still render; the hidden command is the signal.
      console.warn(
        `when-clause did not parse and its command is hidden: ${source} — ${result.error.message} (at ${String(result.error.position)})`,
      );
    }
    return result;
  }

  /** Evaluates a clause: `undefined` is always true, and a clause that does not parse is false. */
  public evaluate(source: string | undefined, context: WhenClauseContext): boolean {
    if (source === undefined) {
      return true;
    }
    const result = this.compile(source);
    return result.ok ? evaluateWhenClause(result.ast, context) : false;
  }
}
