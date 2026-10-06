// Each owner's commands and chords, installed into the window's command registry.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { CommandRegistry } from "./registry.js";
import type { Keybinding } from "./keybinding.js";
import type { CommandDefinition } from "./definition.js";
import { commandRegistry } from "./registry.js";

/** One owner's commands and chords, contributed together so no chord names a missing command. */
export interface CommandContribution {
  /** The owner, for the owner-scoped replace. */
  readonly owner: string;
  readonly commands: readonly CommandDefinition[];
  readonly keyBindings: readonly Keybinding[];
}

/**
 * Withdraws exactly the contribution the call that returned it made.
 * Releasing a superseded one changes nothing; releasing the newest restores the one beneath it.
 */
export type CommandContributionRelease = () => void;

/**
 * Owner-scoped contributions plus a change signal.
 *
 * A re-contribution replaces only the owner's own rows, because composition re-runs (hot
 * reload, tests) and the registry refuses duplicate ids. It emits because a contribution can
 * land after the chord table was installed. Exported so a test can build a second instance.
 */
export class CommandContributionRegistry {
  readonly #registry: CommandRegistry;
  readonly #contributionsByOwner = new Map<string, CommandContribution>();
  readonly #changes = new Emitter<void>("command contribution");
  /**
   * Every live contribution under an owner, oldest first. Two panes of one kind share an
   * owner and only the newest one's rows are registered; closing it restores the older one.
   */
  readonly #liveContributionsByOwner = new Map<string, LiveContribution[]>();

  public constructor(registry: CommandRegistry) {
    this.#registry = registry;
  }

  /** Install `owner`'s rows (the newest live contribution wins) and return its release. */
  public contribute(contribution: CommandContribution): CommandContributionRelease {
    const live = this.#liveContributionsByOwner.get(contribution.owner) ?? [];
    const entry: LiveContribution = { contribution };
    live.push(entry);
    this.#liveContributionsByOwner.set(contribution.owner, live);
    this.#installNewest(contribution.owner);
    return () => {
      this.#release(contribution.owner, entry);
    };
  }

  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Every contributed chord, in the order the owners first contributed. */
  public keyBindings(): readonly Keybinding[] {
    return [...this.#contributionsByOwner.values()].flatMap(
      (contribution) => contribution.keyBindings,
    );
  }

  /** Idempotent, so a cleanup React runs twice cannot withdraw a later contributor's rows. */
  #release(owner: string, entry: LiveContribution): void {
    const live = this.#liveContributionsByOwner.get(owner);
    if (live === undefined) {
      return;
    }
    const position = live.indexOf(entry);
    if (position < 0) {
      return;
    }
    const wasNewest = position === live.length - 1;
    live.splice(position, 1);
    if (live.length === 0) {
      this.#liveContributionsByOwner.delete(owner);
    }
    if (wasNewest) {
      this.#installNewest(owner);
    }
  }

  /** An emptied owner keeps its position so remounting does not reorder a sibling's chords. */
  #installNewest(owner: string): void {
    const live = this.#liveContributionsByOwner.get(owner);
    const newest = live?.[live.length - 1];
    this.#replace(
      newest?.contribution ?? { owner, commands: NO_CONTRIBUTION, keyBindings: NO_CONTRIBUTION },
    );
  }

  #replace(contribution: CommandContribution): void {
    const previous = this.#contributionsByOwner.get(contribution.owner);
    for (const command of previous?.commands ?? []) {
      this.#registry.unregister(command.id);
    }
    // Atomic: a duplicate id keeps all of this owner's rows out.
    this.#registry.registerAll(contribution.commands);
    this.#contributionsByOwner.set(contribution.owner, contribution);
    // After the map write, so a listener re-reading the table sees this owner once.
    this.#changes.emit();
  }
}

/** One live contributor's rows; the entry, not the array, is what a release removes. */
interface LiveContribution {
  readonly contribution: CommandContribution;
}

/** What a released owner contributes; frozen so it cannot grow. */
const NO_CONTRIBUTION: readonly [] = Object.freeze([]);

/** This window's command contributions. */
export const commandContributionRegistry: CommandContributionRegistry =
  new CommandContributionRegistry(commandRegistry);

/** Every contributed chord, in first-contribution order so re-composing never reorders others. */
export function contributedKeybindings(): readonly Keybinding[] {
  return commandContributionRegistry.keyBindings();
}

/** Calls `listener` when an owner contributes or releases, so a composed table can be re-read. */
export function subscribeToCommandContributions(listener: () => void): Unsubscribe {
  return commandContributionRegistry.subscribe(listener);
}
