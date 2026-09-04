// The saved-sidekick registry, projected into what a page can render — and nothing
// else. No React, no bridge call, no state: a function from what the port answered
// to what the rows say.
//
// WHY THE RECORD TYPE IS DERIVED AND NOT RESTATED
//
// `bridge/sidekick-definition.ts` declares the stored row, and the bridge's door
// publishes the bridge rather than the port's vocabulary. So the shape is taken off
// the operation itself — the `SentInvites` precedent — and a hand-written copy of a
// wire shape, which is what a view family would otherwise grow, is a second
// declaration nothing checks against the first. When the contracts package registers
// these types the derivation follows the port there without this module moving.
//
// WHAT AN AXIS IS, AND WHY EACH ONE CARRIES ITS SOURCE
//
// A row is the record's identity (the id and its label) plus one axis per remaining
// member, and every axis says whether what it shows came off the wire or is the
// console's own reading. That is rule 4's provenance signature made a value rather
// than a rendering decision taken twice: the page maps `wire` to the mono figure and
// `console` to the derived one, and no component has to know which axis is which.
//
// The distinction is load-bearing exactly where the stored grammar is. Every
// nullable axis materialises the inherit state as `null`, so "this row pins nothing
// here" is a fact the record states and the console REPHRASES — "The provider's
// default" is our sentence, not the daemon's, and rendering it in mono would claim
// the registry sent those words.
//
// WHAT IS DELIBERATELY NOT PROJECTED
//
// The instruction and goal PROSE. Both are free text an operator wrote and either
// may be pages long; what a list row can honestly say is whether there is any, and
// the text itself belongs to the editor. A clamped passage in a list is a third
// rendering of a body that already has two homes.
//
// The timestamps are carried VERBATIM rather than through `formatClockTime`, which
// fixes to hours, minutes, and seconds because a ledger's day divider carries the
// date. A saved record has no day divider and its two instants span whatever period
// the person has been tuning sidekicks over, so the formatted reading would be
// wrong rather than merely terse — and a wire string rendered exactly as it arrived
// is what rule 4 asks for anyway.

import type { ConsoleBridge } from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { formatCount } from "../primitives/index.js";

/** What one `sidekickDefinitionList` call answers, derived off the port. */
type SidekickDefinitionListOutcome = Awaited<
  ReturnType<ConsoleBridge["growth"]["sidekickDefinitionList"]>
>;

/** One saved definition, exactly as the registry serves it. */
export type SidekickDefinitionRecord = Extract<
  SidekickDefinitionListOutcome,
  { readonly status: "served" }
>["value"][number];

/**
 * Where an axis's text came from. Declared once; the page derives its rendering.
 *
 * `wire` is the registry's own string, shown verbatim in mono. `console` is a
 * sentence or a count this module composed, which mono would misattribute.
 */
export const SIDEKICK_AXIS_SOURCES = ["wire", "console"] as const;

/** One axis's provenance. Derived, so the vocabulary has one home. */
export type SidekickAxisSource = (typeof SIDEKICK_AXIS_SOURCES)[number];

/** One line of a row: what is being named, what it says, and who said it. */
export interface SidekickDefinitionAxis {
  /** Stable across renders and independent of the label's wording. */
  readonly key: string;
  /** The console's word for the axis. Never a wire key. */
  readonly label: string;
  /** The text shown. Verbatim on the `wire` source; ours on `console`. */
  readonly reading: string;
  readonly source: SidekickAxisSource;
}

/** One saved sidekick, ready to render. */
export interface SidekickDefinitionRow {
  readonly definitionId: string;
  /** The mutable label. Nothing keys on it — see {@link SidekickDefinitionRow.definitionId}. */
  readonly name: string;
  /** May be empty: an operator who wrote nothing wrote nothing, and that is a value. */
  readonly description: string;
  readonly axes: readonly SidekickDefinitionAxis[];
}

/**
 * What the page knows about the registry right now.
 *
 * Four arms, and the first three are rule 8's absences kept apart: a read in
 * flight, a read the port refused, and a read that came back with nothing in it.
 * Collapsing any two would let the page tell a person they have saved no sidekicks
 * on the strength of a question that was never answered.
 */
export type SidekickDefinitionReading =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly kind: "empty" }
  | { readonly kind: "rows"; readonly rows: readonly SidekickDefinitionRow[] };

/**
 * A reading that has settled.
 *
 * Narrowed rather than guarded inside {@link describeDefinitionSettlement}: a
 * caller announcing before the read lands is then a compile error rather than a
 * sentence about a settlement that has not happened.
 */
export type SettledSidekickDefinitionReading = Exclude<
  SidekickDefinitionReading,
  { readonly kind: "not-loaded" }
>;

/** The empty registry's own sentence, so the page and its announcement agree. */
export const NO_SAVED_SIDEKICKS = "You have saved no sidekicks on this node";

/**
 * Read one outcome into what the page renders.
 *
 * The refusal travels as the outcome itself, which already IS the console's refusal
 * shape (`bridge/growth-outcome.ts` extends `ConsoleRefusal`), so nothing here
 * rewrites a code or a sentence the port composed.
 */
export function readDefinitionOutcome(
  outcome: SidekickDefinitionListOutcome,
): SettledSidekickDefinitionReading {
  if (outcome.status === "unavailable") {
    return { kind: "refused", refusal: outcome };
  }
  if (outcome.value.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "rows", rows: projectDefinitionRows(outcome.value) };
}

/**
 * One row per definition, in the order a reader scans them.
 *
 * SORTED BY NAME, TIES BROKEN BY ID. The name is what a person is looking for, so
 * it orders the list; the id is what makes the order TOTAL. The registry holds the
 * name unique per node under full Unicode case folding, so a tie should be
 * unreachable — but an ordering that rests on a guarantee it cannot check is an
 * ordering that stops being stable the day the guarantee slips, and an unstable
 * list reshuffles under a person's cursor between two reads of the same data.
 *
 * Comparison runs through `Intl.Collator`, so a name is ordered the way the
 * reader's language orders it rather than by code unit. The id falls back to a
 * code-unit comparison deliberately: it is an opaque daemon-minted token, and
 * collating one would be treating an identifier as text in a language.
 */
export function projectDefinitionRows(
  definitions: readonly SidekickDefinitionRecord[],
  locale?: string,
): readonly SidekickDefinitionRow[] {
  const collator = new Intl.Collator(locale);
  return [...definitions]
    .map((definition) => projectDefinitionRow(definition))
    .sort((left, right) => {
      const byName = collator.compare(left.name, right.name);
      if (byName !== 0) {
        return byName;
      }
      return compareIdentifiers(left.definitionId, right.definitionId);
    });
}

/** What a settled read says out loud, once. */
export function describeDefinitionSettlement(reading: SettledSidekickDefinitionReading): string {
  if (reading.kind === "refused") {
    // The port's own sentence, verbatim. The console never paraphrases a refusal,
    // and the code stays out of the spoken form: read aloud it is a token nobody
    // can act on, ahead of the sentence that matters.
    return reading.refusal.detail;
  }
  if (reading.kind === "empty") {
    return `${NO_SAVED_SIDEKICKS}.`;
  }
  const count = reading.rows.length;
  return `Read ${formatCount(count)} saved ${count === 1 ? "sidekick" : "sidekicks"}.`;
}

/**
 * The question the two-step delete asks before it asks the daemon anything.
 *
 * It names the record and states the one fact that makes the answer easy: deleting
 * a saved sidekick reaches nothing already running, because an attach COPIES the
 * definition rather than referencing it. A confirmation that only asked "are you
 * sure" would leave a person weighing a consequence the registry does not have.
 */
export function describeDeletionQuestion(row: SidekickDefinitionRow): string {
  return `Delete “${row.name}”? A sidekick already attached from it keeps the configuration it was given.`;
}

function projectDefinitionRow(definition: SidekickDefinitionRecord): SidekickDefinitionRow {
  return {
    definitionId: definition.definitionId,
    name: definition.name,
    description: definition.description,
    // Every member of the record the header does not already carry, in the order
    // the stored shape declares them, so a reader can check the projection against
    // the shape by reading down. An axis for a member that is not there would be a
    // field invented in a view family, which is the whole failure the growth port
    // exists to prevent.
    axes: [
      wireAxis("driver", "Driver", definition.driverName),
      wireAxis("model", "Model", definition.modelId),
      pinnedAxis("account", "Account", definition.providerAccountId, "The provider's default"),
      pinnedAxis("effort", "Effort", definition.effort, "The driver's default"),
      pinnedAxis("posture", "Posture", definition.executionPostureMode, "Not pinned"),
      consoleAxis("tools", "Tools", describeToolAllowlist(definition.toolAllowlist)),
      consoleAxis("instructions", "Instructions", describeProsePresence(definition.instructions)),
      consoleAxis("goal", "Goal", describeProsePresence(definition.goal)),
      wireAxis("created", "Created", definition.createdAt),
      wireAxis("updated", "Updated", definition.updatedAt),
    ],
  };
}

function wireAxis(key: string, label: string, reading: string): SidekickDefinitionAxis {
  return { key, label, reading, source: "wire" };
}

function consoleAxis(key: string, label: string, reading: string): SidekickDefinitionAxis {
  return { key, label, reading, source: "console" };
}

/**
 * An axis that is either pinned to a wire value or left at the inherit state.
 *
 * The two arms carry different sources on purpose: a pinned value is the
 * registry's string and the inherit state is a sentence this console wrote about
 * an absence, and rendering the second in mono would attribute our words to the
 * daemon.
 */
function pinnedAxis(
  key: string,
  label: string,
  pinned: string | null,
  inheritReading: string,
): SidekickDefinitionAxis {
  return pinned === null ? consoleAxis(key, label, inheritReading) : wireAxis(key, label, pinned);
}

/**
 * The allowlist's three states, said in three different ways.
 *
 * `null` is the driver's defaults, `[]` is no tools at all, and a populated list is
 * exactly those. The first two read alike and mean opposite things, so neither is
 * allowed to render as the other — which is the reason the stored shape keeps them
 * apart in the first place.
 */
function describeToolAllowlist(allowlist: readonly string[] | null): string {
  if (allowlist === null) {
    return "The driver's defaults";
  }
  if (allowlist.length === 0) {
    return "No tools";
  }
  return `${formatCount(allowlist.length)} ${allowlist.length === 1 ? "tool" : "tools"}`;
}

/** Whether there is prose, never the prose. See the header. */
function describeProsePresence(prose: string | null): string {
  return prose !== null && prose.length > 0 ? "Written" : "None";
}

/** Total, and deliberately not collated. See {@link projectDefinitionRows}. */
function compareIdentifiers(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
