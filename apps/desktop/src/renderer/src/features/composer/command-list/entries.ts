// What a leading slash opens and what the popover lists: pure decisions over two sources. A
// console entry is an act this client performs; a provider entry is discovery only, so the
// entry type is a union and a render cannot forget to ask whether one can be acted on. Provider
// `description`, `scope` and `enabled` are wire-verbatim or absent, never defaulted. Only one
// binding's group reaches the list, because a command enumerated under one binding is never
// offered under another.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import type { CommandDefinition } from "#renderer/registries/commands/definition.js";
import type { ComposerTarget } from "../target.js";

/** One act this console performs, offered where the composer is mounted. */
export interface ConsoleCommandEntry {
  readonly source: "console";
  readonly key: string;
  /** The command's id, which is both what it is called and what a person types. */
  readonly name: string;
  readonly description: string | undefined;
  /** What the popover's action runs. Present on this arm and only on this arm. */
  readonly commandId: string;
}

/** One command or skill the bound provider published, for discovery only. */
export interface ProviderCommandEntry {
  readonly source: "provider";
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly kind: ProviderCommandBindingGroup["entries"][number]["kind"];
  readonly scope: string | undefined;
  readonly enabled: boolean | undefined;
  /** The binding this entry was read under, carried with the entry rather than beside it. */
  readonly driverName: ProviderName;
  /** `null` is the wire's positive statement that no account was bound. */
  readonly providerAccountId: string | null;
}

/** One row of the command list: a console act or a provider discovery entry. */
export type CommandListEntry = ConsoleCommandEntry | ProviderCommandEntry;

/**
 * The binding the composer is addressed to, as much of it as the console holds. Both members
 * are `undefined`-able because the projections answer with an incomplete target; an absent
 * member matches nothing rather than everything.
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
 * The one group whose binding the addressed run is on, or `undefined`. Tried in order: a
 * group whose `runId` names the addressed run; otherwise the single group on the addressed
 * driver, since `runId` is `null` both when no run is live and when several are. Ambiguity
 * answers `undefined` rather than resolving by order, and the list then renders "published
 * nothing here" instead of falling back to another binding's entries.
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
export function composeCommandList(input: {
  readonly runnableCommands: readonly CommandDefinition[];
  readonly providerGroups: readonly ProviderCommandBindingGroup[];
}): readonly CommandListEntry[] {
  const consoleEntries: CommandListEntry[] = input.runnableCommands.map((command) => ({
    source: "console",
    key: `console:${command.id}`,
    name: command.id,
    description: command.title,
    commandId: command.id,
  }));
  const providerEntries: CommandListEntry[] = [];
  for (const group of input.providerGroups) {
    for (const entry of group.entries) {
      providerEntries.push({
        source: "provider",
        // Keyed by the binding as well as the name: two bindings can each publish `review`, and
        // a name-only key would collapse them into one row whose provenance depended on order.
        key:
          `provider:${group.binding.driverName}:` +
          `${group.binding.providerAccountId ?? ""}:${entry.name}`,
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
 * Whether the provider declared this entry unavailable. `enabled` is three-valued on the
 * wire, so the test is against `false` and never falsiness: an absent flag read as disabled
 * would report a state the provider never published. Shared so the row and the key handler
 * cannot spell the test two ways.
 */
export function isDeclaredUnavailable(entry: CommandListEntry): boolean {
  return entry.source === "provider" && entry.enabled === false;
}

/**
 * The entries whose name begins with what has been typed. Case-insensitive and a prefix rather
 * than the palette's subsequence matcher, because the line is parsed by its first word and a
 * loosely matched entry would be one the send path then refuses.
 */
export function filterCommandList(
  entries: readonly CommandListEntry[],
  prefix: string,
): readonly CommandListEntry[] {
  if (prefix.length === 0) {
    return entries;
  }
  const wanted = prefix.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(wanted));
}
