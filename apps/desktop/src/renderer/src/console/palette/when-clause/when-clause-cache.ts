// Parsed clauses, keyed by source text.
//
// The palette re-evaluates every command's clause on every keystroke, so parsing
// per evaluation would re-tokenize the same handful of strings thousands of times
// across a session. The cache is also what keeps the development-mode warning
// honest: a broken clause warns ONCE, when it is first compiled, instead of once
// per character typed.
//
// It is a class rather than a module-level map because the memo IS state, and one
// instance per registry is what keeps an auxiliary window's clause set out of the
// main window's — the same reasoning the registry itself is per window.

import { evaluateWhenClause, type WhenClauseContext } from "./when-clause.js";
import { parseWhenClause, type WhenClauseParseResult } from "./when-clause-parser.js";

/** A memo over `parseWhenClause`, one instance per command registry. */
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
}
