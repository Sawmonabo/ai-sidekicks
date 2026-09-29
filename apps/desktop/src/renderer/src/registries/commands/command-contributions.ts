// The window's command contributions: each owner's commands and chords, installed into
// the window's command registry, and the signal that they changed.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { CommandRegistry } from "./command-registry.js";
import type { ConsoleCommand, KeyBinding } from "./command-types.js";
import { consoleCommands } from "./window-command-registry.js";

/**
 * One owner's commands and chords, contributed together.
 *
 * One value rather than two calls, so a chord cannot name a command nobody registered.
 */
export interface ConsoleFamilyCommandContribution {
  /** The owner, for the owner-scoped replace. */
  readonly owner: string;
  readonly commands: readonly ConsoleCommand[];
  readonly keyBindings: readonly KeyBinding[];
}

/**
 * Withdraw exactly the contribution the call that returned it made.
 *
 * A superseded contributor's release leaves the registry untouched; the newest one's
 * hands the owner back to whichever contribution is still live beneath it.
 */
export type ConsoleContributionRelease = () => void;

/** What a feature contributes its commands through. */
export interface ConsoleCommandSurface {
  contribute(contribution: ConsoleFamilyCommandContribution): ConsoleContributionRelease;
}

/**
 * The contributions, owner-scoped, and the signal that they changed.
 *
 * Owner-scoped rather than additive because composition re-runs (a hot reload, every
 * test that composes the features): the registry refuses a duplicate id and the
 * keybinding table two bindings on one chord, so a re-contribution replaces the
 * owner's own rows and touches nobody else's. It emits because a contribution can land
 * after the window installed its chord table, and whatever installs the table re-reads.
 *
 * Exported so a test can build a second instance: "a second composition holds its own
 * contributors" is a property of the class, unprovable against the window's singleton.
 */
export class ConsoleFamilyContributions implements ConsoleCommandSurface {
  readonly #registry: CommandRegistry;
  readonly #contributionsByOwner = new Map<string, ConsoleFamilyCommandContribution>();
  readonly #changes = new Emitter<void>("command contribution");
  /**
   * Every contribution still live under an owner, oldest first.
   *
   * Two panes of one kind are two live contributors under one owner, and only the
   * newest one's rows are registered. The earlier entries are kept so that closing the
   * newer pane hands the rows back to the older one instead of emptying the owner. Held
   * on the instance, so a second composition cannot supersede an owner it has no rows in.
   */
  readonly #liveContributionsByOwner = new Map<string, LiveContribution[]>();

  public constructor(registry: CommandRegistry) {
    this.#registry = registry;
  }

  /** Install `owner`'s rows (the newest live contribution wins) and return its release. */
  public contribute(contribution: ConsoleFamilyCommandContribution): ConsoleContributionRelease {
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
  public keyBindings(): readonly KeyBinding[] {
    return [...this.#contributionsByOwner.values()].flatMap(
      (contribution) => contribution.keyBindings,
    );
  }

  /**
   * Withdraw one contribution. Idempotent, so a cleanup React runs twice withdraws
   * nothing a later contributor owns; removing a superseded one leaves the registry alone.
   */
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

  /**
   * Register the newest contribution under `owner`, or empty the owner.
   *
   * An emptied owner keeps its slot, so a surface that goes and comes back does not
   * reorder the window's chords under a sibling that never moved.
   */
  #installNewest(owner: string): void {
    const live = this.#liveContributionsByOwner.get(owner);
    const newest = live?.[live.length - 1];
    this.#replace(
      newest?.contribution ?? { owner, commands: NO_CONTRIBUTION, keyBindings: NO_CONTRIBUTION },
    );
  }

  #replace(contribution: ConsoleFamilyCommandContribution): void {
    const previous = this.#contributionsByOwner.get(contribution.owner);
    for (const command of previous?.commands ?? []) {
      this.#registry.unregister(command.id);
    }
    // Atomic: a duplicate id anywhere keeps this owner's rows out rather than half in.
    this.#registry.registerAll(contribution.commands);
    this.#contributionsByOwner.set(contribution.owner, contribution);
    // After the map is written, so a listener re-reading the table sees this owner once.
    this.#changes.emit();
  }
}

/**
 * One live contributor's rows. The entry, minted inside `contribute`, is the identity a
 * release removes: two mounts can hand over the very same memoized array.
 */
interface LiveContribution {
  readonly contribution: ConsoleFamilyCommandContribution;
}

/** What a released owner contributes. Frozen, so a caller cannot make it grow. */
const NO_CONTRIBUTION: readonly [] = Object.freeze([]);

/** This window's command contributions. */
export const consoleFamilyContributions: ConsoleFamilyContributions =
  new ConsoleFamilyContributions(consoleCommands);

/** The contribution half of this window's contributions, for the features. */
export const consoleCommandSurface: ConsoleCommandSurface = consoleFamilyContributions;

/**
 * Every contributed chord, in the order the owners first contributed.
 *
 * First-contribution order, so re-composing one owner never reorders another's chords.
 */
export function consoleFamilyKeyBindings(): readonly KeyBinding[] {
  return consoleFamilyContributions.keyBindings();
}

/** Told when an owner contributes or releases, so a composed table can be read again. */
export function subscribeToConsoleFamilyContributions(listener: () => void): Unsubscribe {
  return consoleFamilyContributions.subscribe(listener);
}
