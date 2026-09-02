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

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";

import type { ConsoleCommand } from "../../../console/palette/index.js";

/** The prefix that opens the discovery surface. */
export const DISCOVERY_TRIGGER = "/";

/** The escape that sends a message really beginning with a slash — never a trigger. */
export const LITERAL_SLASH_ESCAPE = "//";

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
 * The name a person is filtering by, or `undefined` when the line opens nothing.
 *
 * `//` opens nothing: it is the send router's own escape for a message that really
 * begins with a slash, and a discovery popover over it would offer commands for text
 * that is deliberately not a command.
 */
export function readDiscoveryPrefix(lineText: string): string | undefined {
  const line = lineText.trimStart();
  if (!line.startsWith(DISCOVERY_TRIGGER) || line.startsWith(LITERAL_SLASH_ESCAPE)) {
    return undefined;
  }
  const afterSlash = line.slice(DISCOVERY_TRIGGER.length);
  const firstSpace = afterSlash.search(/\s/u);
  return firstSpace === -1 ? afterSlash : afterSlash.slice(0, firstSpace);
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
