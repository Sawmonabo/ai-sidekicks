// What a leading slash opens and what the popover lists: pure decisions over three sources. A
// console entry is an act this client performs; a provider entry is discovery only; a skill entry
// is picked into the message. The entry type is a union, so a render cannot forget to ask which
// one it holds. Provider `description`, `scope` and `enabled` are wire-verbatim or absent, never
// defaulted. Only one binding's group reaches the list, because a command enumerated under one
// binding is never offered under another. A skill is never a provider row: the daemon's skill list
// is the one inventory of skills, so a row the provider marks as a skill is dropped by that mark,
// and the list offers only the skills the addressed provider can run.

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider/driver/commands";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { QueuedSkillPick } from "@ai-sidekicks/contracts/run/queue";
import type { SkillListEntry } from "@ai-sidekicks/contracts/skill";

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

/** One command or tool server prompt the bound provider published, for discovery only. */
export interface ProviderCommandEntry {
  readonly source: "provider";
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly kind: Exclude<ProviderCommandBindingGroup["entries"][number]["kind"], "skill">;
  readonly scope: string | undefined;
  readonly enabled: boolean | undefined;
  /** The binding this entry was read under, carried with the entry rather than beside it. */
  readonly providerName: ProviderId;
  readonly providerAccountId: ProviderAccountId;
}

/** One skill the addressed provider can run, picked into the message as its call form. */
export interface SkillCommandEntry {
  readonly source: "skill";
  readonly key: string;
  readonly name: string;
  readonly description: string | undefined;
  /** What the provider is called with, which the pick puts at the head of the line. */
  readonly callForm: string;
  /** What the send carries, so the folder picked is the one that runs. */
  readonly pick: QueuedSkillPick;
  readonly origin: SkillListEntry["origin"];
  readonly originProvider: ProviderId | undefined;
  readonly pluginName: string | undefined;
  readonly scope: SkillListEntry["scope"];
  /** The daemon's own reason it could not load the skill, which grays the row. */
  readonly loadError: string | undefined;
}

/** One row of the command list: a console act, a provider discovery entry or a skill. */
export type CommandListEntry = ConsoleCommandEntry | ProviderCommandEntry | SkillCommandEntry;

/**
 * The binding the composer is addressed to, as much of it as the console holds. Both members
 * are `undefined`-able because the projections answer with an incomplete target; an absent
 * member matches nothing rather than everything.
 */
export interface AddressedProviderBinding {
  readonly runId: string | undefined;
  readonly providerName: ProviderId | undefined;
}

/** What this composer's target says about the binding a reply must be routed to. */
export function addressedProviderBinding(target: ComposerTarget): AddressedProviderBinding {
  if (target.kind !== "run") {
    return { runId: undefined, providerName: undefined };
  }
  return { runId: target.targetRunId, providerName: target.providerName };
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
    addressed.providerName === undefined
      ? []
      : groups.filter((group) => group.binding.providerName === addressed.providerName);
  return onThisDriver.length === 1 ? onThisDriver[0] : undefined;
}

/**
 * Compose the three sources into one list: console acts, then the provider's words with no
 * provider-marked skill, then the skills `providerName` can run. A skill another provider alone
 * runs, or whose folder is gone, is absent; with no addressed provider no skill is offered.
 */
export function composeCommandList(input: {
  readonly runnableCommands: readonly CommandDefinition[];
  readonly providerGroups: readonly ProviderCommandBindingGroup[];
  readonly skills: readonly SkillListEntry[];
  readonly providerName: ProviderId | undefined;
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
      if (entry.kind === "skill") {
        continue;
      }
      providerEntries.push({
        source: "provider",
        // Keyed by the binding as well as the name: two bindings can each publish `review`, and
        // a name-only key would collapse them into one row whose provenance depended on order.
        key:
          `provider:${group.binding.providerName}:` +
          `${group.binding.providerAccountId}:${entry.name}`,
        name: entry.name,
        description: entry.description,
        kind: entry.kind,
        scope: entry.scope,
        enabled: entry.enabled,
        providerName: group.binding.providerName,
        providerAccountId: group.binding.providerAccountId,
      });
    }
  }
  const skillEntries: CommandListEntry[] = [];
  for (const skill of input.skills) {
    const callForm = skill.callForms.find((form) => form.provider === input.providerName);
    const isRunnable = skill.availability.some(
      (availability) => availability.provider === input.providerName && availability.available,
    );
    if (skill.orphaned || !isRunnable || callForm === undefined) {
      continue;
    }
    skillEntries.push({
      source: "skill",
      key: `skill:${skill.skillId}`,
      name: skill.name,
      description: skill.description ?? undefined,
      callForm: callForm.callForm,
      pick: { name: skill.name, folderPath: skill.folderPath },
      origin: skill.origin,
      originProvider: skill.originProvider,
      pluginName: skill.pluginName,
      scope: skill.scope,
      loadError: skill.loadError ?? undefined,
    });
  }
  return [...consoleEntries, ...providerEntries, ...skillEntries];
}

/**
 * Whether this entry cannot be acted on: the provider declared it disabled, or the skill failed to
 * load. `enabled` is three-valued on the wire, so the test is against `false` and never falsiness:
 * an absent flag read as disabled would report a state the provider never published. Shared so
 * the row and the key handler cannot spell the test two ways.
 */
export function isDeclaredUnavailable(entry: CommandListEntry): boolean {
  switch (entry.source) {
    case "provider":
      return entry.enabled === false;
    case "skill":
      return entry.loadError !== undefined;
    case "console":
      return false;
  }
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
