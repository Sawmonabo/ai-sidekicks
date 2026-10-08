// The saved-definition registry projected into rows a page can render: no React, no bridge
// call, no state. Each axis carries its source so the page shows a wire string verbatim in
// mono and the app's own sentence (an inherit `null` rephrased) in the derived style. A saved
// record's instants are drawn as ages, with the zoned time as their hover.

import type { AgentDefinition } from "@ai-sidekicks/contracts/agent/definition";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import { compareCodeUnits } from "#renderer/lib/compare-code-units.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { NAMELESS_TOOL_ALLOWLIST_WORDING } from "../pane/tool-allowlist/position.js";

/**
 * Where an axis's text came from. `wire` is the registry's own string, shown verbatim in
 * mono; `instant` is a registry timestamp, shown as its age with its zoned time on hover;
 * `composed` is a word, sentence or count this module composed, which mono would misattribute.
 */
export const AGENT_AXIS_SOURCES = ["wire", "instant", "composed"] as const;

/** One axis's provenance. */
export type AgentAxisSource = (typeof AGENT_AXIS_SOURCES)[number];

/** One line of a row: what is named, what it says, and who said it. */
export interface AgentDefinitionAxis {
  /** Stable across renders and independent of the label's wording. */
  readonly key: string;
  /** The app's word for the axis. Never a wire key. */
  readonly label: string;
  /** The text shown. Verbatim on the `wire` source; ours on `composed`. */
  readonly reading: string;
  readonly source: AgentAxisSource;
}

/** One saved definition, ready to render. */
export interface AgentDefinitionRow {
  readonly definitionId: string;
  /** The mutable label. Nothing keys on it — see {@link AgentDefinitionRow.definitionId}. */
  readonly name: string;
  /** May be empty: a person who wrote nothing wrote nothing, and that is a value. */
  readonly description: string;
  readonly axes: readonly AgentDefinitionAxis[];
}

/**
 * What the page knows about the registry right now. The first two arms are kept apart on
 * purpose: a read in flight is not a read that came back empty, and merging them would tell
 * a person they saved nothing before the question was answered.
 */
export type AgentDefinitionReading =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "empty" }
  | { readonly kind: "rows"; readonly rows: readonly AgentDefinitionRow[] };

/**
 * A reading that has settled. Narrowed so announcing before the read lands is a compile
 * error rather than a sentence about a settlement that has not happened.
 */
export type SettledAgentDefinitionReading = Exclude<
  AgentDefinitionReading,
  { readonly kind: "not-loaded" }
>;

/** The empty registry's own sentence, so the page and its announcement agree. */
export const NO_SAVED_DEFINITIONS: string =
  "No sidekicks yet — a sidekick is a set of instructions and a " +
  "model binding you tune once and reuse in every session and " +
  "workflow.";

/** Read the registry's rows into what the page renders. */
export function readDefinitions(
  definitions: readonly AgentDefinition[],
): SettledAgentDefinitionReading {
  if (definitions.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "rows", rows: projectDefinitionRows(definitions) };
}

/**
 * One row per definition, sorted by name with ties broken by id.
 *
 * Names collate in the reader's locale; the id is the tiebreak that makes the order total
 * (the registry keeps names unique per node, but an unstable order would reshuffle the list
 * between reads). Ids compare by code unit: they are opaque tokens, not text.
 */
export function projectDefinitionRows(
  definitions: readonly AgentDefinition[],
  locale?: string,
): readonly AgentDefinitionRow[] {
  const collator = new Intl.Collator(locale);
  return [...definitions]
    .map((definition) => projectDefinitionRow(definition))
    .sort((left, right) => {
      const byName = collator.compare(left.name, right.name);
      if (byName !== 0) {
        return byName;
      }
      return compareCodeUnits(left.definitionId, right.definitionId);
    });
}

/** What a settled read says out loud, once. */
export function describeDefinitionSettlement(reading: SettledAgentDefinitionReading): string {
  if (reading.kind === "empty") {
    return NO_SAVED_DEFINITIONS;
  }
  const count = reading.rows.length;
  return `Read ${formatCount(count)} saved ${count === 1 ? "sidekick" : "sidekicks"}.`;
}

/** The question the two-step delete asks, naming the record, before it asks the daemon. */
export function describeDeletionQuestion(row: AgentDefinitionRow): string {
  return `Delete “${row.name}”?`;
}

function projectDefinitionRow(definition: AgentDefinition): AgentDefinitionRow {
  const binding = definition.bindings.default;
  return {
    definitionId: definition.definitionId,
    name: definition.name,
    description: definition.description,
    // Declared-shape order, so the projection can be checked against the shape by reading down.
    axes: [
      composedAxis("driver", "Driver", PROVIDER_LABELS[binding.driverName]),
      wireAxis("model", "Model", binding.modelId),
      pinnedAxis("account", "Account", binding.providerAccountId, "The provider's default"),
      pinnedAxis("effort", "Effort", binding.effort, "The driver's default"),
      composedAxis("tools", "Tools", describeToolAllowlist(definition.toolAllowlist)),
      composedAxis("instructions", "Instructions", describeProsePresence(definition.instructions)),
      composedAxis("goal", "Goal", describeProsePresence(definition.goal)),
      instantAxis("created", "Created", definition.createdAt),
      instantAxis("updated", "Updated", definition.updatedAt),
    ],
  };
}

function wireAxis(key: string, label: string, reading: string): AgentDefinitionAxis {
  return { key, label, reading, source: "wire" };
}

function instantAxis(key: string, label: string, reading: string): AgentDefinitionAxis {
  return { key, label, reading, source: "instant" };
}

function composedAxis(key: string, label: string, reading: string): AgentDefinitionAxis {
  return { key, label, reading, source: "composed" };
}

/**
 * An axis either pinned to a wire value or left at the inherit state. The inherit sentence is
 * ours, so it carries the `composed` source; rendering it in mono would attribute it to the daemon.
 */
function pinnedAxis(
  key: string,
  label: string,
  pinned: string | null,
  inheritReading: string,
): AgentDefinitionAxis {
  return pinned === null ? composedAxis(key, label, inheritReading) : wireAxis(key, label, pinned);
}

/**
 * The allowlist's three states: `null` is the provider's default set, `[]` is no tools, a list
 * is exactly those. The first two must never render as each other, and read as the pane does.
 */
function describeToolAllowlist(allowlist: readonly string[] | null): string {
  if (allowlist === null) {
    return NAMELESS_TOOL_ALLOWLIST_WORDING["driver-default"].reading;
  }
  if (allowlist.length === 0) {
    return NAMELESS_TOOL_ALLOWLIST_WORDING["no-tools"].reading;
  }
  return `${formatCount(allowlist.length)} ${allowlist.length === 1 ? "tool" : "tools"}`;
}

/** Whether there is prose, never the prose: the text belongs to the editor. */
function describeProsePresence(prose: string | null): string {
  return prose !== null && prose.length > 0 ? "Written" : "None";
}
