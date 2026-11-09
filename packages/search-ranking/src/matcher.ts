// The product's one fuzzy matcher on the page: `crates/sidekicks-search`'s scorer, compiled to
// WebAssembly, instantiated once from a module compiled elsewhere and handed over, since the page
// that runs it may compile nothing itself. A query matches a candidate when it is a
// case-insensitive subsequence of it; the score is the best embedding, and the matched indices are
// UTF-16 units of the candidate, as JavaScript indexes it. Text crosses as UTF-16 written into the
// module's own buffers, and a buffer's address holds only until the next call that resizes it, so
// every view is taken afresh after the call that sized it. The scorer gives equal scores no order;
// `rank` keeps their input order, so rows do not trade places between keystrokes.

/** A scored embedding of a query inside a candidate. */
export interface SubsequenceMatch {
  /** Higher is better; unbounded both ways, so only the ordering means anything. */
  readonly score: number;
  /** Indices into the candidate in UTF-16 units, ascending, one per query unit. */
  readonly matchedIndices: readonly number[];
}

/** One candidate a ranking kept: where it sat in the list it came in, and its match. */
export interface RankedCandidate {
  readonly index: number;
  readonly match: SubsequenceMatch;
}

/**
 * The matcher, which holds nothing until it is handed its compiled module and then scores on the
 * page's own thread. Until then every candidate scores as no match, and a subscriber hears when the
 * module arrives, so a list drawn early is drawn again.
 */
export class FuzzyMatcher {
  readonly #listeners = new Set<() => void>();
  /** The module handed over, kept so a trap can start it again, and its running instance. */
  #started: { readonly module: WebAssembly.Module; instance: MatcherInstance } | undefined;

  /** Whether the matcher holds its module, so it scores. */
  public get isReady(): boolean {
    return this.#started !== undefined;
  }

  /**
   * Instantiates `module` and keeps it, then tells every subscriber; a module in hand is kept over
   * a later one. Throws when the module does not start or lacks the exports the crate declares,
   * leaving the matcher waiting for another.
   */
  public provide(module: WebAssembly.Module): void {
    if (this.#started !== undefined) {
      return;
    }
    this.#started = { module, instance: instanceOf(module) };
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  /** Calls `listener` once the module arrives; the returned function stops it. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * `candidate` scored against `query`, or `undefined` when the query is empty, is not a
   * case-insensitive subsequence of it, or the module has not arrived. Throws when the module
   * traps, after starting it again for the next call.
   */
  public score(candidate: string, query: string): SubsequenceMatch | undefined {
    return this.#run((instance) => {
      const scratchView = instance.unitsAt(
        instance.exports.scratch(candidate.length + query.length),
        candidate.length + query.length,
      );
      writeUnits(scratchView, 0, candidate);
      writeUnits(scratchView, candidate.length, query);
      const score = instance.exports.score(candidate.length, query.length);
      if (Number.isNaN(score)) {
        return undefined;
      }
      return {
        score,
        matchedIndices: [...instance.indicesAt(instance.exports.indices(), query.length)],
      };
    });
  }

  /**
   * Every candidate scored against `query` in one call into the module, each at its own position:
   * its match, or `undefined` where it has none, and every one `undefined` while the module has
   * not arrived. Throws as `score` does.
   */
  public scoreList(
    candidates: readonly string[],
    query: string,
  ): readonly (SubsequenceMatch | undefined)[] {
    return (
      this.#run((instance) => {
        const { exports } = instance;
        let unitCount = 0;
        for (const candidate of candidates) {
          unitCount += candidate.length;
        }
        const listView = instance.unitsAt(
          exports.list_reserve(unitCount, candidates.length),
          unitCount,
        );
        const offsetsView = instance.offsetsAt(exports.list_offsets(), candidates.length + 1);
        let offset = 0;
        candidates.forEach((candidate, index) => {
          offsetsView[index] = offset;
          writeUnits(listView, offset, candidate);
          offset += candidate.length;
        });
        offsetsView[candidates.length] = offset;
        writeUnits(instance.unitsAt(exports.scratch(query.length), query.length), 0, query);
        exports.score_list(query.length);
        const scores = instance.scoresAt(exports.list_scores(), candidates.length);
        const indices = instance.indicesAt(exports.indices(), candidates.length * query.length);
        return candidates.map((_, index): SubsequenceMatch | undefined => {
          const score = scores[index] ?? Number.NaN;
          return Number.isNaN(score)
            ? undefined
            : {
                score,
                matchedIndices: [
                  ...indices.subarray(index * query.length, (index + 1) * query.length),
                ],
              };
        });
      }) ?? candidates.map(() => undefined)
    );
  }

  /**
   * The candidates `query` matches, best first, through `scoreList`; equal scores keep the order
   * they came in, so a list ranked again under the next keystroke keeps its ties in place.
   */
  public rank(candidates: readonly string[], query: string): readonly RankedCandidate[] {
    const ranked: RankedCandidate[] = [];
    this.scoreList(candidates, query).forEach((match, index) => {
      if (match !== undefined) {
        ranked.push({ index, match });
      }
    });
    // `Array.prototype.sort` is stable, so equal scores keep their input order.
    return ranked.sort((left, right) => right.match.score - left.match.score);
  }

  /**
   * `call` on the running instance, or `undefined` before the module arrives. A trap leaves the
   * module's buffers in no known state, so the instance is started again from the module before
   * the trap is thrown on.
   */
  #run<Result>(call: (instance: MatcherInstance) => Result): Result | undefined {
    const started = this.#started;
    if (started === undefined) {
      return undefined;
    }
    try {
      return call(started.instance);
    } catch (error: unknown) {
      if (error instanceof WebAssembly.RuntimeError) {
        started.instance = instanceOf(started.module);
      }
      throw error;
    }
  }
}

/** The exports of the matcher's module, as `ranking.rs` declares them; addresses are bytes. */
interface MatcherExports {
  readonly memory: WebAssembly.Memory;
  scratch(units: number): number;
  indices(): number;
  /** NaN when the query does not match. */
  score(candidateLength: number, queryLength: number): number;
  list_reserve(units: number, count: number): number;
  list_offsets(): number;
  list_scores(): number;
  score_list(queryLength: number): number;
}

/** A running module, with views over its memory taken at the moment they are asked for. */
interface MatcherInstance {
  readonly exports: MatcherExports;
  unitsAt(address: number, length: number): Uint16Array;
  offsetsAt(address: number, length: number): Uint32Array;
  indicesAt(address: number, length: number): Uint32Array;
  scoresAt(address: number, length: number): Float64Array;
}

/** The functions the matcher's module exports. */
const MATCHER_FUNCTION_NAMES = [
  "scratch",
  "indices",
  "score",
  "list_reserve",
  "list_offsets",
  "list_scores",
  "score_list",
] as const;

/**
 * A running instance of `module`. Throws when it does not start, or lacks the exports the crate
 * declares, as an instance of some other module would.
 */
function instanceOf(module: WebAssembly.Module): MatcherInstance {
  const { exports } = new WebAssembly.Instance(module, {});
  if (
    !(exports["memory"] instanceof WebAssembly.Memory) ||
    MATCHER_FUNCTION_NAMES.some((name) => typeof exports[name] !== "function")
  ) {
    throw new Error("The fuzzy matcher's module lacks the exports it declares");
  }
  const matcherExports = exports as unknown as MatcherExports;
  const buffer = (): ArrayBuffer => matcherExports.memory.buffer;
  return {
    exports: matcherExports,
    unitsAt: (address, length) => new Uint16Array(buffer(), address, length),
    offsetsAt: (address, length) => new Uint32Array(buffer(), address, length),
    indicesAt: (address, length) => new Uint32Array(buffer(), address, length),
    scoresAt: (address, length) => new Float64Array(buffer(), address, length),
  };
}

/** Writes `text`'s UTF-16 units into `view` from `start`. */
function writeUnits(view: Uint16Array, start: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view[start + index] = text.charCodeAt(index);
  }
}
