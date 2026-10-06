// The list of every command the app offers, with recents and search, and this window's instance.
// Module scope is window scope: every window is its own renderer process, so a feature registers
// its commands where it declares them instead of threading a registry through props. A window's
// own commands close over its store, so they are registered from an effect and removed on unmount.
//
// A duplicate id is an error, not an overwrite: the survivor would depend on module
// evaluation order. `commandsFor` decides only what the palette offers from `when` clauses;
// a command the daemon may refuse is still offered, and the refusal is rendered when it returns.

import { lossyStringify } from "#renderer/lib/wire/errors.js";

import { KeyedRegistry } from "#renderer/lib/keyed-registry.js";
import type { CommandDefinition } from "./definition.js";
import {
  compareCommandsForDisplay,
  rankCommandsForEmptyQuery,
  rankCommandsForQuery,
  type CommandSearchResult,
} from "./ranking.js";
import { WhenClauseCache } from "./when-clause/cache.js";
import { type WhenClauseContext } from "./when-clause/semantics.js";

/** What happened when a caller asked the registry to run a command. */
export type CommandInvocationOutcome =
  | { readonly status: "ran"; readonly commandId: string; readonly completion: Promise<void> }
  | { readonly status: "unknown-command"; readonly commandId: string }
  | { readonly status: "hidden-in-context"; readonly commandId: string }
  | {
      readonly status: "unavailable";
      readonly commandId: string;
      /** The contributor's own sentence, carried through and never paraphrased. */
      readonly reason: string;
    };

/** The window's command list; one instance per window. */
export class CommandRegistry {
  readonly #commandsById = new KeyedRegistry<string, CommandDefinition>({
    duplicatePolicy: "throw",
    describeWhat: "command",
    duplicateHint:
      "two contributors cannot claim one id, because the winner would be decided by module " +
      "evaluation order",
  });
  readonly #recentCommandIds: string[] = [];
  readonly #whenClauses = new WhenClauseCache();

  /** Registers one command. Throws `DuplicateRegistrationError` on a repeated id. */
  public register(command: CommandDefinition): void {
    this.#commandsById.register(command.id, command);
  }

  /** Registers a set atomically: every id is checked first, so a duplicate changes nothing. */
  public registerAll(commands: readonly CommandDefinition[]): void {
    this.#commandsById.registerAll(commands.map((command) => [command.id, command]));
  }

  /** Removes a command and drops it from recents. Returns whether it was registered. */
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

  public get(commandId: string): CommandDefinition | undefined {
    return this.#commandsById.get(commandId);
  }

  /** Every registered command, in registration order, ignoring visibility. */
  public all(): readonly CommandDefinition[] {
    return this.#commandsById.all();
  }

  /** Every command offered in this context, ordered by group then title. */
  public commandsFor(context: WhenClauseContext): readonly CommandDefinition[] {
    const visible: CommandDefinition[] = [];
    for (const command of this.#commandsById.all()) {
      if (this.#whenClauses.evaluate(command.when, context)) {
        visible.push(command);
      }
    }
    visible.sort(compareCommandsForDisplay);
    return visible;
  }

  /** Moves a registered command to the front of recents; ignores unknown ids. */
  public recordInvocation(commandId: string): void {
    if (!this.#commandsById.has(commandId)) {
      return;
    }
    const existingIndex = this.#recentCommandIds.indexOf(commandId);
    if (existingIndex >= 0) {
      this.#recentCommandIds.splice(existingIndex, 1);
    }
    this.#recentCommandIds.unshift(commandId);
    if (this.#recentCommandIds.length > COMMAND_PALETTE_RECENTS_CAP) {
      this.#recentCommandIds.length = COMMAND_PALETTE_RECENTS_CAP;
    }
  }

  /**
   * Runs a command by id, failing closed on visibility. Returns the command's promise
   * without awaiting it, so a key handler never blocks on a long-lived dialog; a synchronous
   * throw from `run` becomes a rejected `completion` instead of aborting the key dispatch.
   */
  public invoke(commandId: string, context: WhenClauseContext): CommandInvocationOutcome {
    const command = this.#commandsById.get(commandId);
    if (command === undefined) {
      return { status: "unknown-command", commandId };
    }
    if (!this.#whenClauses.evaluate(command.when, context)) {
      return { status: "hidden-in-context", commandId };
    }
    if (command.unavailable !== undefined) {
      // Before `recordInvocation`: a row that did not run must not move to the top of recents.
      return { status: "unavailable", commandId, reason: command.unavailable };
    }
    this.recordInvocation(commandId);
    let completion: Promise<void>;
    try {
      completion = Promise.resolve(command.run());
    } catch (error) {
      // `String(...)` throws on a null-prototype value, which would escape `invoke`.
      completion = Promise.reject(
        error instanceof Error ? error : new Error(lossyStringify(error)),
      );
    }
    return { status: "ran", commandId, completion };
  }

  /**
   * Ranks the visible commands against a query. An empty query returns recents first and then
   * the rest in category order. Eligibility is settled by `commandsFor`, order by the ranking.
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

/** How many recently run commands the palette remembers. */
const COMMAND_PALETTE_RECENTS_CAP = 8;

/** This window's command registry. */
export const commandRegistry: CommandRegistry = new CommandRegistry();

/** Registers several commands atomically: every id is validated before any is added. */
export function registerCommands(commands: readonly CommandDefinition[]): void {
  commandRegistry.registerAll(commands);
}
