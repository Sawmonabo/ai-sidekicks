// The command registry — one list of every act the console offers.
//
// `Spec-023 §Console Design (Meridian)` §Layout grammar: "The command palette
// has categories, recents, a scoped-context row naming what the command acts on,
// and one matcher shared with settings search." Categories are `group`; recents
// are `recordInvocation`; the matcher is `scoreSubsequence`, reached through
// `command-ranking.ts` rather than re-implemented, because "one matcher" is a
// claim that fails the moment a second surface writes its own ranking.
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

import { KeyedRegistry, PALETTE_RECENTS_CAP } from "../core/index.js";
import type { ConsoleCommand } from "./contributions.js";
import {
  compareCommandsForDisplay,
  rankCommandsForEmptyQuery,
  rankCommandsForQuery,
  type CommandSearchResult,
} from "./command-ranking.js";
import { WhenClauseCache } from "./when-clause-cache.js";
import type { WhenClauseContext } from "./when-clause.js";
import type { WhenClauseParseError } from "./when-clause-parser.js";

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
    visible.sort(compareCommandsForDisplay);
    return visible;
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
   *
   * Which commands are ELIGIBLE is settled here, by `commandsFor`; what order the
   * eligible ones come back in is settled by `command-ranking.ts`. A ranker that
   * could also hide a row would be a second source of truth for eligibility.
   */
  public search(query: string, context: WhenClauseContext): readonly CommandSearchResult[] {
    const trimmedQuery = query.trim();
    const visibleCommands = this.commandsFor(context);
    const recentRankById = new Map<string, number>();
    this.#recentCommandIds.forEach((commandId, rank) => {
      recentRankById.set(commandId, rank);
    });

    return trimmedQuery.length === 0
      ? rankCommandsForEmptyQuery(visibleCommands, recentRankById)
      : rankCommandsForQuery(visibleCommands, trimmedQuery, recentRankById);
  }
}
