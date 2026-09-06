// This window's command registry, and the door a family contributes to it through.
//
// One registry per window, held at module scope for the same reason
// `consoleSurfaceRegistry` and `consoleRouteRegistry` are: an auxiliary window is
// its own renderer process, so module scope IS window scope here, and a family can
// register its commands where it declares them rather than threading a registry
// through props it has no other use for. I-023-12's "auxiliary windows share no
// store" holds by construction — there is no channel between two processes' module
// graphs.
//
// IT LIVES IN `palette/` AND NOT IN `frame/`, WHICH IS WHERE IT WAS. Every input is
// this family's or below it — the registry, the two contribution types, the host's
// chord platform, `core`'s refusal — and the frame owns none of them; what the frame
// owns is its OWN command vocabulary, which stays there. The move is what the
// console's door rule requires rather than a tidying: `frame/` is the top family, so
// `frame/index.ts` reaches `ConsoleRoot` and through it `families.ts` and every view
// family, and a family importing that door closes a cycle. Every view family
// therefore wrote a deep specifier into `frame/command-surface.ts` instead, which
// `console-cross-family-deep-import` reports and whose remedy that rule states in one
// sentence: hoist the symbol to the lowest family that owns its inputs and import it
// from that family's door. `contributions.ts` beside this file already declares what a
// family contributes; this is where those contributions are collected.
//
// The frame's OWN commands are not registered here. They close over a live store,
// which module scope cannot reach, so `ConsoleRoot` registers them in an effect and
// removes them on unmount.

import type { ConsoleRefusal, Unsubscribe } from "../core/index.js";
import { HOST_CHORD_PLATFORM, type ChordPlatform } from "../primitives/index.js";
import { CommandRegistry } from "./command-registry.js";
import type { ConsoleCommand, KeyBinding } from "./contributions.js";

/** This window's command registry. */
export const consoleCommands: CommandRegistry = new CommandRegistry();

/**
 * Contribute one command.
 *
 * Refuses a duplicate id rather than replacing: two families that both register
 * `session.open` have a real conflict, and silently keeping the last one would make
 * which command runs depend on module import order.
 */
export function registerConsoleCommand(command: ConsoleCommand): void {
  consoleCommands.register(command);
}

/** Contribute several. Atomic — every id is validated before any is added. */
export function registerConsoleCommands(commands: readonly ConsoleCommand[]): void {
  consoleCommands.registerAll(commands);
}

/**
 * The platform the chord printer formats for.
 *
 * Re-exported from the chord vocabulary's single host reading rather than detected
 * again here. A second detection is how the printed and spoken forms of a chord
 * came apart once already; one reading is why they cannot.
 */
export const CONSOLE_CHORD_PLATFORM: ChordPlatform = HOST_CHORD_PLATFORM;

/**
 * What a family contributes when the console is composed: its acts and its chords.
 *
 * One value rather than two calls, because a chord naming a command nobody
 * registered is a keypress that silently does nothing — the pair arrives together
 * so it cannot come apart.
 */
export interface ConsoleFamilyCommandContribution {
  /** The family, for the owner-scoped replace below. */
  readonly owner: string;
  readonly commands: readonly ConsoleCommand[];
  readonly keyBindings: readonly KeyBinding[];
}

/** The door a family contributes its commands and chords through. */
export interface ConsoleCommandSurface {
  contribute(contribution: ConsoleFamilyCommandContribution): void;
}

/**
 * The families' contributions, owner-scoped.
 *
 * OWNER-SCOPED RATHER THAN ADDITIVE, for the reason composition is idempotent
 * everywhere else in the console: `registerConsoleFamilies` runs at module scope in
 * production and repeatedly in a test, and a hot reload re-runs it again. Additive
 * contribution would raise on the second pass — the command registry refuses a
 * duplicate id, and the key-binding table refuses two bindings on one chord — so a
 * family re-contributing REPLACES its own previous rows and touches nobody else's.
 *
 * The frame's own commands do not come through here: they close over one window's
 * store, so they are registered from an effect and removed on unmount.
 */
class ConsoleFamilyContributions implements ConsoleCommandSurface {
  readonly #registry: CommandRegistry;
  readonly #contributionsByOwner = new Map<string, ConsoleFamilyCommandContribution>();

  public constructor(registry: CommandRegistry) {
    this.#registry = registry;
  }

  public contribute(contribution: ConsoleFamilyCommandContribution): void {
    const previous = this.#contributionsByOwner.get(contribution.owner);
    for (const command of previous?.commands ?? []) {
      this.#registry.unregister(command.id);
    }
    // `registerAll` is atomic, so a duplicate id anywhere in the list adds none of
    // it — which keeps this owner's rows out of the registry rather than half in.
    this.#registry.registerAll(contribution.commands);
    this.#contributionsByOwner.set(contribution.owner, contribution);
  }

  public keyBindings(): readonly KeyBinding[] {
    return [...this.#contributionsByOwner.values()].flatMap(
      (contribution) => contribution.keyBindings,
    );
  }
}

/** This window's family contributions. */
const consoleFamilyContributions = new ConsoleFamilyContributions(consoleCommands);

/** The door `console/families.ts` composes each family's commands through. */
export const consoleCommandSurface: ConsoleCommandSurface = consoleFamilyContributions;

/**
 * Every chord the FAMILIES bind, in contribution order.
 *
 * The frame prepends its own and publishes the whole table; this half is the part
 * that lives with the contributions it reads, so a family's chords reach the keyboard
 * without the frame naming the family — the same relationship the surface registry
 * gives a family's routes.
 */
export function consoleFamilyKeyBindings(): readonly KeyBinding[] {
  return consoleFamilyContributions.keyBindings();
}

/**
 * Where an act with no surface of its own states its refusal.
 *
 * A family's commands are contributed at composition time and a refusal is
 * produced at press time, so the two cannot share a closure: the act is built
 * before any window exists and the banner belongs to the window that is open when
 * it runs. The frame publishes its own banner sink here at mount and withdraws it
 * on unmount, which is what makes "the ledger is not open in this window" a
 * sentence a person reads rather than a press that does nothing.
 *
 * One sink rather than a fan-out: this is rule 9's banner rendering, and the frame
 * is the only thing that has one.
 */
class ConsoleActRefusalChannel {
  #sink: ((refusal: ConsoleRefusal) => void) | undefined;

  public publish(sink: (refusal: ConsoleRefusal) => void): Unsubscribe {
    this.#sink = sink;
    return () => {
      if (this.#sink === sink) {
        this.#sink = undefined;
      }
    };
  }

  /** Deliver a refusal. Answers whether anything was there to render it. */
  public raise(refusal: ConsoleRefusal): boolean {
    if (this.#sink === undefined) {
      return false;
    }
    this.#sink(refusal);
    return true;
  }
}

const consoleActRefusals = new ConsoleActRefusalChannel();

/** Publish this window's refusal rendering. The frame calls it; nothing else does. */
export function publishConsoleActRefusalSink(sink: (refusal: ConsoleRefusal) => void): Unsubscribe {
  return consoleActRefusals.publish(sink);
}

/**
 * State a refusal from an act that has no surface of its own.
 *
 * The answer says whether it was rendered, so a caller that has its own surface can
 * fall back to it rather than assuming a banner appeared.
 */
export function raiseConsoleActRefusal(refusal: ConsoleRefusal): boolean {
  return consoleActRefusals.raise(refusal);
}
