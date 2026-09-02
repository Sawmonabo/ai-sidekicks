// The command registry — one list of every act the console offers, and the
// ranking that turns a query into rows.
//
// `Spec-023 §Console Design (Meridian)` §Layout grammar: "The command palette
// has categories, recents, a scoped-context row naming what the command acts on,
// and one matcher shared with settings search." Categories are `group`; recents
// are `recordInvocation`; the matcher is `scoreSubsequence`, imported rather than
// re-implemented, because "one matcher" is a claim that fails the moment a second
// surface writes its own ranking.
//
// TWO RULES WORTH STATING BEFORE THE CODE:
//
//   • A DUPLICATE ID IS AN ERROR, not an overwrite. Two families contributing the
//     same command id is a wiring bug, and the overwrite arm resolves it by
//     import order — meaning the surviving command depends on which module the
//     bundler happened to evaluate last, and the loser fails silently and only
//     for some builds. The same reasoning the frame's route registry applies to
//     a second claim on one route.
//   • ELIGIBILITY IS NEVER PROJECTED. `commandsFor` decides what the palette
//     OFFERS, from `when` clauses the frame's own context answers; it does not
//     decide what the daemon will permit. A command whose daemon call may be
//     refused is still offered, and its refusal is rendered when it comes back —
//     `Spec-023 §Console Design (Meridian)`'s "Offer, then render the refusal".

import { KeyedRegistry, PALETTE_RECENTS_CAP, PALETTE_RESULT_CAP } from "../core/index.js";
import { scoreSubsequence, type SubsequenceMatch } from "./subsequence-score.js";
import {
  WhenClauseCache,
  type WhenClauseContext,
  type WhenClauseNode,
  type WhenClauseParseError,
} from "./when-clause.js";

/** One act the console offers. */
export interface ConsoleCommand {
  /** Stable, unique, namespaced by owning family — `session.rename`, not `rename`. */
  readonly id: string;
  /** Sentence case, no trailing punctuation, names the act — console copy rules. */
  readonly title: string;
  /** The palette category this row sits under. Also a secondary match field. */
  readonly group: string;
  /** A `when-clause.ts` expression. Absent means unconditional. */
  readonly when?: string;
  /** Extra words a person might type for this command. Matched below the title. */
  readonly keywords?: readonly string[];
  /**
   * Perform the act. May be asynchronous; the registry never awaits it.
   *
   * A `run` MUST SETTLE. `invoke` hands its promise back and the palette drops it,
   * deliberately — the dialog must not stay open waiting on a command that opens
   * another surface — so a `run` that rejects reaches no surface at all and becomes
   * an unhandled rejection. A command that can fail catches its own failure and
   * renders it (`palette/bridge-commands.ts` is the worked example).
   */
  readonly run: () => void | Promise<void>;
}

/** Which text of a command a result matched on. Rendered as provenance, not just rank. */
export type CommandMatchField = "title" | "keyword" | "group";

/** One ranked row. */
export interface CommandSearchResult {
  readonly command: ConsoleCommand;
  /** Higher is better. Comparable only within one `search` call. */
  readonly score: number;
  readonly field: CommandMatchField;
  /**
   * Character positions in `command.title` to emphasise, when the match was on the
   * title. Deliberately a required member typed `| undefined` rather than an
   * optional one: `exactOptionalPropertyTypes` makes those two different types,
   * and a required-but-absent value is the honest shape for "there is no title
   * match to emphasise".
   */
  readonly titleMatch: SubsequenceMatch | undefined;
  /** 0 = most recently invoked. `undefined` when the command is not in recents. */
  readonly recentRank: number | undefined;
}

/** A clause that did not parse, named with the command it hid. */
export interface CommandClauseDiagnostic {
  readonly commandId: string;
  readonly error: WhenClauseParseError;
}

/** What happened when a caller asked the registry to run a command. */
export type CommandInvocationOutcome =
  | { readonly status: "ran"; readonly commandId: string; readonly completion: Promise<void> }
  | { readonly status: "unknown-command"; readonly commandId: string }
  | { readonly status: "hidden-in-context"; readonly commandId: string };

/**
 * Subtracted from a match on a field other than the title.
 *
 * ADDITIVE, never multiplicative. A multiplier looks equivalent and is not: a
 * scattered title match can score below zero, and multiplying a negative by a
 * fraction makes it LARGER — a keyword hit would then outrank the title hit it
 * was supposed to sit under. Subtraction is monotone at every score.
 */
export const COMMAND_KEYWORD_FIELD_PENALTY = 40;

/** As above, for the weakest field. A group name is context, not the act's name. */
export const COMMAND_GROUP_FIELD_PENALTY = 64;

/**
 * Added to a recently invoked command's score, decaying by one per position.
 *
 * Small on purpose: recency breaks ties between comparable matches and must never
 * float a poor match over a good one, because a palette that answers with the
 * last thing you ran rather than the thing you typed stops being a search.
 */
export const COMMAND_RECENCY_BONUS = 12;

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The console's command list.
 *
 * One instance per window. An auxiliary window registers only the commands it can
 * actually perform, which is what keeps its palette honest about what that window
 * can do — the same reasoning the frame applies to auxiliary route registration.
 */
export class CommandRegistry {
  // `"throw"`: two contributors claiming one id is a real conflict, and keeping
  // either one would make which command runs depend on module evaluation order.
  readonly #commandsById = new KeyedRegistry<string, ConsoleCommand>({
    duplicatePolicy: "throw",
    describeWhat: "command",
    duplicateHint:
      "two contributors cannot claim one id, because the winner would be decided by module evaluation order",
  });
  readonly #recentCommandIds: string[] = [];
  readonly #whenClauses = new WhenClauseCache();

  /** Register one command. Throws `DuplicateRegistrationError` on a repeated id. */
  public register(command: ConsoleCommand): void {
    this.#commandsById.register(command.id, command);
  }

  /**
   * Register a set atomically: every id is checked before anything is stored, so
   * a duplicate half way through a family's contribution leaves the registry
   * exactly as it was rather than half-populated.
   */
  public registerAll(commands: readonly ConsoleCommand[]): void {
    this.#commandsById.registerAll(commands.map((command) => [command.id, command]));
  }

  /** Remove a command. Returns whether it was there. Also drops it from recents. */
  public unregister(commandId: string): boolean {
    const removed = this.#commandsById.unregister(commandId);
    const recentIndex = this.#recentCommandIds.indexOf(commandId);
    if (recentIndex >= 0) {
      this.#recentCommandIds.splice(recentIndex, 1);
    }
    return removed;
  }

  public has(commandId: string): boolean {
    return this.#commandsById.has(commandId);
  }

  public get(commandId: string): ConsoleCommand | undefined {
    return this.#commandsById.get(commandId);
  }

  /** How many commands are registered, visible or not. */
  public get size(): number {
    return this.#commandsById.size;
  }

  /** Every registered command, in registration order, ignoring visibility. */
  public all(): readonly ConsoleCommand[] {
    return this.#commandsById.all();
  }

  /**
   * Is this command offered in this context?
   *
   * False for an unknown command, false for an unparseable clause, false for a
   * clause naming a key the context does not carry. Three different reasons, one
   * fail-closed answer — see `when-clause.ts`.
   */
  public isVisible(commandId: string, context: WhenClauseContext): boolean {
    const command = this.#commandsById.get(commandId);
    if (command === undefined) {
      return false;
    }
    return this.#whenClauses.evaluate(command.when, context);
  }

  /** Every command offered in this context, ordered by group then title. */
  public commandsFor(context: WhenClauseContext): readonly ConsoleCommand[] {
    const visible: ConsoleCommand[] = [];
    for (const command of this.#commandsById.all()) {
      if (this.#whenClauses.evaluate(command.when, context)) {
        visible.push(command);
      }
    }
    visible.sort(
      (left, right) =>
        compareStrings(left.group, right.group) ||
        compareStrings(left.title, right.title) ||
        compareStrings(left.id, right.id),
    );
    return visible;
  }

  /** The parsed clause for a command, for the keybinding table's conflict check. */
  public whenClauseFor(commandId: string): WhenClauseNode | undefined {
    const command = this.#commandsById.get(commandId);
    if (command?.when === undefined) {
      return undefined;
    }
    return this.#whenClauses.astFor(command.when);
  }

  /**
   * Clauses that did not parse, paired with the command each one hid.
   *
   * The palette renders these as the `error` kind of nothing. A hidden command
   * with no visible reason would look like a command that was never contributed,
   * and those two absences call for different fixes.
   */
  public clauseDiagnostics(): readonly CommandClauseDiagnostic[] {
    const diagnostics: CommandClauseDiagnostic[] = [];
    for (const command of this.#commandsById.all()) {
      if (command.when === undefined) {
        continue;
      }
      const parsed = this.#whenClauses.compile(command.when);
      if (!parsed.ok) {
        diagnostics.push({ commandId: command.id, error: parsed.error });
      }
    }
    return diagnostics;
  }

  /** Record that a command was invoked, moving it to the front of recents. */
  public recordInvocation(commandId: string): void {
    if (!this.#commandsById.has(commandId)) {
      return;
    }
    const existingIndex = this.#recentCommandIds.indexOf(commandId);
    if (existingIndex >= 0) {
      this.#recentCommandIds.splice(existingIndex, 1);
    }
    this.#recentCommandIds.unshift(commandId);
    if (this.#recentCommandIds.length > PALETTE_RECENTS_CAP) {
      this.#recentCommandIds.length = PALETTE_RECENTS_CAP;
    }
  }

  /** Most recently invoked first. In-memory only: recents are per window, per run. */
  public recentCommandIds(): readonly string[] {
    return [...this.#recentCommandIds];
  }

  /**
   * Run a command by id, fail-closed on visibility.
   *
   * Synchronous, returning the command's own promise rather than awaiting it, so
   * a keybinding dispatch does not block the key handler on a command that opens
   * a dialog and resolves minutes later. A synchronous throw inside `run` becomes
   * a rejected `completion` rather than an exception at the key handler, which
   * would otherwise abort the rest of the dispatch.
   */
  public invoke(commandId: string, context: WhenClauseContext): CommandInvocationOutcome {
    const command = this.#commandsById.get(commandId);
    if (command === undefined) {
      return { status: "unknown-command", commandId };
    }
    if (!this.#whenClauses.evaluate(command.when, context)) {
      return { status: "hidden-in-context", commandId };
    }
    this.recordInvocation(commandId);
    let completion: Promise<void>;
    try {
      completion = Promise.resolve(command.run());
    } catch (error) {
      completion = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return { status: "ran", commandId, completion };
  }

  /**
   * Rank the visible commands against a query.
   *
   * An EMPTY query is a different state, not a query that matches everything: it
   * returns recents first and then the rest in category order, which is what the
   * palette shows the moment it opens. `scoreSubsequence` refuses an empty query
   * for the same reason, so the two halves cannot drift.
   */
  public search(query: string, context: WhenClauseContext): readonly CommandSearchResult[] {
    const trimmedQuery = query.trim();
    const visibleCommands = this.commandsFor(context);
    const recentRankById = new Map<string, number>();
    this.#recentCommandIds.forEach((commandId, rank) => {
      recentRankById.set(commandId, rank);
    });

    if (trimmedQuery.length === 0) {
      return this.#emptyQueryResults(visibleCommands, recentRankById);
    }

    const results: CommandSearchResult[] = [];
    for (const command of visibleCommands) {
      const scored = this.#scoreCommand(command, trimmedQuery);
      if (scored === undefined) {
        continue;
      }
      const recentRank = recentRankById.get(command.id);
      const recencyBonus =
        recentRank === undefined ? 0 : Math.max(0, COMMAND_RECENCY_BONUS - recentRank);
      results.push({
        command,
        score: scored.score + recencyBonus,
        field: scored.field,
        titleMatch: scored.titleMatch,
        recentRank,
      });
    }

    results.sort(this.#compareResults);
    return results.slice(0, PALETTE_RESULT_CAP);
  }

  #emptyQueryResults(
    visibleCommands: readonly ConsoleCommand[],
    recentRankById: ReadonlyMap<string, number>,
  ): readonly CommandSearchResult[] {
    const recentResults: CommandSearchResult[] = [];
    const remainingResults: CommandSearchResult[] = [];
    for (const command of visibleCommands) {
      const recentRank = recentRankById.get(command.id);
      const result: CommandSearchResult = {
        command,
        score: 0,
        field: "title",
        titleMatch: undefined,
        recentRank,
      };
      if (recentRank === undefined) {
        remainingResults.push(result);
      } else {
        recentResults.push(result);
      }
    }
    recentResults.sort((left, right) => (left.recentRank ?? 0) - (right.recentRank ?? 0));
    // `visibleCommands` already arrives in group-then-title order, so the
    // remainder needs no second sort — and must not get one, or the categories
    // would reshuffle between an empty query and a cleared query.
    return [...recentResults, ...remainingResults].slice(0, PALETTE_RESULT_CAP);
  }

  #scoreCommand(
    command: ConsoleCommand,
    query: string,
  ):
    | { score: number; field: CommandMatchField; titleMatch: SubsequenceMatch | undefined }
    | undefined {
    const titleMatch = scoreSubsequence(command.title, query);
    let best:
      | { score: number; field: CommandMatchField; titleMatch: SubsequenceMatch | undefined }
      | undefined =
      titleMatch === undefined
        ? undefined
        : { score: titleMatch.score, field: "title", titleMatch };

    for (const keyword of command.keywords ?? []) {
      const keywordMatch = scoreSubsequence(keyword, query);
      if (keywordMatch === undefined) {
        continue;
      }
      const score = keywordMatch.score - COMMAND_KEYWORD_FIELD_PENALTY;
      if (best === undefined || score > best.score) {
        best = { score, field: "keyword", titleMatch: undefined };
      }
    }

    const groupMatch = scoreSubsequence(command.group, query);
    if (groupMatch !== undefined) {
      const score = groupMatch.score - COMMAND_GROUP_FIELD_PENALTY;
      if (best === undefined || score > best.score) {
        best = { score, field: "group", titleMatch: undefined };
      }
    }

    return best;
  }

  /**
   * Score first, then a chain of stable keys. The tail of the chain ends at `id`,
   * which is unique, so the order is TOTAL — two renders of one result set are
   * byte-identical, which is what the screenshot tier depends on.
   */
  readonly #compareResults = (left: CommandSearchResult, right: CommandSearchResult): number => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const leftRecency = left.recentRank ?? Number.MAX_SAFE_INTEGER;
    const rightRecency = right.recentRank ?? Number.MAX_SAFE_INTEGER;
    if (leftRecency !== rightRecency) {
      return leftRecency - rightRecency;
    }
    return (
      compareStrings(left.command.group, right.command.group) ||
      compareStrings(left.command.title, right.command.title) ||
      compareStrings(left.command.id, right.command.id)
    );
  };
}
