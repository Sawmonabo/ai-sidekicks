import type { RailDestination } from "#renderer/routing/readers.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { RAIL_CONTROL_LABELS } from "../control-labels.js";

/** A destination as the rail names it: where it goes and the word it shows. */
export interface LabeledRailDestination {
  readonly destination: RailDestination;
  readonly label: string;
}

/** What the rail's strings are made from: its entries, their chords, the count and the dot. */
export interface RailNamesInput<Entry extends LabeledRailDestination> {
  readonly entries: readonly Entry[];
  readonly settingsEntry: Entry;
  readonly chords: Readonly<Partial<Record<RailDestination, string>>>;
  readonly attention: { readonly count?: number };
  readonly isUpdateStaged: boolean;
}

/** One destination with its one string: its hover label and its spoken name at once. */
export interface NamedRailEntry<Entry extends LabeledRailDestination> {
  readonly entry: Entry;
  readonly name: string;
}

/** What the rail writes: each control's one string, and the figure the attention pip draws. */
export interface RailNames<Entry extends LabeledRailDestination> {
  /** The destinations above the spacer, in rail order. */
  readonly namedEntries: readonly NamedRailEntry<Entry>[];
  readonly settingsName: string;
  readonly attentionName: string;
  /** The waiting count as the pip draws it; `undefined` when nothing waits and no pip is drawn. */
  readonly pipFigure: string | undefined;
}

/**
 * The rail's strings. A destination's name ends in its chord where it has one, and each mark
 * hidden from assistive technology is spoken through the name of the button it sits on.
 */
export function useRailNames<Entry extends LabeledRailDestination>(
  input: RailNamesInput<Entry>,
): RailNames<Entry> {
  const { attention, chords, settingsEntry } = input;
  const pipFigure = isAnythingWaiting(attention.count) ? formatCount(attention.count) : undefined;
  const notifications = RAIL_CONTROL_LABELS.notifications;
  return {
    namedEntries: input.entries.map((entry) => ({
      entry,
      name: nameWithChord(entry.label, chords[entry.destination]),
    })),
    settingsName: settingsName(
      nameWithChord(settingsEntry.label, chords[settingsEntry.destination]),
      input.isUpdateStaged,
    ),
    attentionName:
      pipFigure === undefined ? notifications : `${notifications}, ${pipFigure} waiting`,
    pipFigure,
  };
}

function nameWithChord(label: string, chord: string | undefined): string {
  return chord === undefined ? label : `${label} ${chord}`;
}

// The dot is hidden from assistive technology, so the name carries the staged update.
function settingsName(name: string, isUpdateStaged: boolean): string {
  return isUpdateStaged ? `${name}, an update is ready` : name;
}

// A zero is nothing waiting: the pip and the figure are absent rather than reading zero.
function isAnythingWaiting(count: number | undefined): count is number {
  return count !== undefined && count > 0;
}
