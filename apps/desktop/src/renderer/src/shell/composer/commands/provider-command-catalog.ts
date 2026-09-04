// What a leading slash OPENS, and what the popover lists once it is open.
//
// Pure, and separate from both the read and the component, because the two rules
// worth pinning are decisions rather than renders: when the discovery surface is
// open at all, and which entries survive the prefix a person has typed.
//
// TWO SOURCES, ONE LIST, AND THEY ARE NOT INTERCHANGEABLE. A console entry is an
// act this client performs — Spec-017's C-18 reserves the slash prefix for exactly
// those. A provider entry is DISCOVERY: `Spec-023 §Signature Feature Composition
// Sketches` §The Session Composer has the autocomplete "surface what the bound
// provider offers" and states that selecting one "inserts nothing into the message
// box and starts no turn". So the entry type is a discriminated union rather than one
// shape with an optional command id: the difference decides whether an entry can be
// acted on at all, and an optional member would let a render forget to ask.
//
// EVERY PROVIDER FIELD IS WIRE-VERBATIM OR ABSENT. `description`, `scope`, and
// `enabled` are each present exactly when the provider declared one — the contract is
// explicit that an omitted description means the provider published none and that a
// synthesized `enabled: true` would be a fabricated reading. Nothing here defaults
// any of the three.
//
// AND EXACTLY ONE BINDING'S ENTRIES REACH THE LIST. The reply is agent-scoped and an
// agent can hold several live bindings at once — an older Claude run beside a newer
// Codex one — so it carries ONE GROUP PER BINDING, each naming the `runId` and the
// `(driverName, providerAccountId)` it was read under. Passing every group into the
// catalog put commands and skills from bindings the addressed run does not use under
// the addressed run's own name, which is the routing invariant `Spec-005 §The
// provider command and skill surface` exists to forbid. `selectAddressedBindingGroup`
// is where that selection happens, once, for both readers of this enumeration.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";

import type { ConsoleCommand } from "../../../console/palette/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";

/** One act this console performs, offered where the composer is mounted. */
export interface ConsoleCatalogEntry {
  readonly source: "console";
  readonly key: string;
  /** The command's id, which is both what it is called and what a person types. */
  readonly name: string;
  readonly description: string | undefined;
  /** What the popover's action runs. Present on this arm and only on this arm. */
  readonly commandId: string;
}

/** One command or skill the bound provider published, for discovery only. */
export interface ProviderCatalogEntry {
  readonly source: "provider";
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly kind: "command" | "skill";
  readonly scope: string | undefined;
  readonly enabled: boolean | undefined;
  /** The binding this entry was READ UNDER, carried with the entry rather than beside it. */
  readonly driverName: string;
  /** `null` is the wire's positive statement that no account was bound. */
  readonly providerAccountId: string | null;
}

export type CommandCatalogEntry = ConsoleCatalogEntry | ProviderCatalogEntry;

/**
 * The binding the composer is addressed to, as much of it as the console holds.
 *
 * Both members are `undefined`-able because both come from projections that answer
 * with an incomplete target routinely — the run id is present exactly on the
 * provider-bound path, and the driver name arrives only once the agent entity carries
 * one. An absent member matches nothing rather than matching everything.
 */
export interface AddressedProviderBinding {
  readonly runId: string | undefined;
  readonly driverName: string | undefined;
}

/** What this composer's target says about the binding a reply must be routed to. */
export function addressedProviderBinding(target: ComposerTarget): AddressedProviderBinding {
  if (target.path !== "provider-bound") {
    return { runId: undefined, driverName: undefined };
  }
  return { runId: target.targetRunId, driverName: target.driverName };
}

/**
 * The one group whose binding the addressed run is on, or `undefined`.
 *
 * TWO ROUTING FACTS, TRIED IN THE ORDER THE WIRE MAKES THEM TRUSTWORTHY.
 *
 *   1. **The group names this run.** `runId` is the reply's own positive attribution
 *      — the arm the contract reaches when exactly one run is live on that binding —
 *      so a group naming the addressed run IS the addressed binding.
 *   2. **The group names this run's driver, and no sibling does.** `runId` is `null`
 *      on two legitimate arms: no run is live on the binding, and two or more are, in
 *      which case the addressed run may well be one of them. The composer's own
 *      address carries the driver the agent is bound to, so a single group on that
 *      driver is the addressed binding by elimination.
 *
 * Anything else answers `undefined`, and the surface renders that as "this run's
 * binding published nothing here" rather than falling back to another binding's
 * entries. Ambiguity is refused rather than resolved by order: two groups claiming
 * one run is contradictory provenance, and two groups on one driver with no run
 * attribution is a coin flip presented as routing.
 */
export function selectAddressedBindingGroup(
  groups: readonly ProviderCommandBindingGroup[],
  addressed: AddressedProviderBinding,
): ProviderCommandBindingGroup | undefined {
  const namingThisRun =
    addressed.runId === undefined ? [] : groups.filter((group) => group.runId === addressed.runId);
  if (namingThisRun.length === 1) {
    return namingThisRun[0];
  }
  if (namingThisRun.length > 1) {
    return undefined;
  }
  const onThisDriver =
    addressed.driverName === undefined
      ? []
      : groups.filter((group) => group.binding.driverName === addressed.driverName);
  return onThisDriver.length === 1 ? onThisDriver[0] : undefined;
}

/** Compose the two sources into one list, console acts first. */
export function composeCatalog(input: {
  readonly offeredCommands: readonly ConsoleCommand[];
  readonly providerGroups: readonly ProviderCommandBindingGroup[];
}): readonly CommandCatalogEntry[] {
  const consoleEntries: CommandCatalogEntry[] = input.offeredCommands.map((command) => ({
    source: "console",
    key: `console:${command.id}`,
    name: command.id,
    description: command.title,
    commandId: command.id,
  }));
  const providerEntries: CommandCatalogEntry[] = [];
  for (const group of input.providerGroups) {
    for (const entry of group.entries) {
      providerEntries.push({
        source: "provider",
        // Keyed by the binding as well as the name: one agent can hold two bindings
        // that each publish `review`, and a name-only key would collapse them into
        // one row whose provenance depended on iteration order.
        key: `provider:${group.binding.driverName}:${group.binding.providerAccountId ?? ""}:${entry.name}`,
        name: entry.name,
        description: entry.description,
        kind: entry.kind,
        scope: entry.scope,
        enabled: entry.enabled,
        driverName: group.binding.driverName,
        providerAccountId: group.binding.providerAccountId,
      });
    }
  }
  return [...consoleEntries, ...providerEntries];
}

/**
 * Whether the provider declared this entry unavailable.
 *
 * `enabled` is THREE-VALUED on the wire and each value means a different thing:
 * `false` is the provider declaring the entry disabled, `true` is it declaring the
 * entry available, and ABSENT is the provider drawing no such distinction at all.
 * So the test is against `false` and never against falsiness — an absent flag read
 * as disabled would report a state the provider never published, which is the same
 * fabrication as the synthesized `enabled: true` the contract forbids at the other
 * end.
 *
 * Here rather than at either reader: the row renders the state and the popover's key
 * handler answers a press on one, and two spellings of one three-valued test is the
 * pair that drifts.
 */
export function isDeclaredUnavailable(entry: CommandCatalogEntry): boolean {
  return entry.source === "provider" && entry.enabled === false;
}

/**
 * The entries whose name begins with what has been typed.
 *
 * Case-insensitive and a PREFIX rather than the palette's subsequence matcher, and
 * the difference is deliberate: this list completes a name a person is part way
 * through typing into a line that will be parsed by its first word, so an entry that
 * matched loosely would be an entry the send path then refuses.
 */
export function filterCatalog(
  entries: readonly CommandCatalogEntry[],
  prefix: string,
): readonly CommandCatalogEntry[] {
  if (prefix.length === 0) {
    return entries;
  }
  const wanted = prefix.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(wanted));
}
