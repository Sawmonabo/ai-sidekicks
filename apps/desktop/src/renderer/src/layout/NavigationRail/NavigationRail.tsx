// The icon rail: the destinations, a spacer, the attention and color-scheme controls, then Settings
// at the foot, always in the same place, so a person builds muscle memory. It renders exactly the
// entries it is handed and has no availability flag: an unreachable destination is absent, not
// disabled. It carries no color except the accent on the current destination and two marks: the
// attention pip and the Settings dot. Each control has one string, its hover title and its spoken
// name at once.

import type { GlyphName } from "#renderer/styles/glyphs.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import type { RailDestination } from "#renderer/routing/readers.js";

import "./NavigationRail.css";

/** What one destination shows. Availability is decided elsewhere. */
export interface RailEntryTemplate {
  readonly label: string;
  readonly glyph: GlyphName;
}

/** One rail destination with what it shows. */
export interface RailEntry extends RailEntryTemplate {
  readonly destination: RailDestination;
}

/** The attention control: what waits on a person, and the notifications list it opens and shuts. */
export interface RailAttentionControl {
  /**
   * The sessions and workflow runs waiting on a person now, as the daemon counts them; absent or
   * with none waiting, no pip is drawn and the name carries no figure.
   */
  readonly count?: number;
  /** Whether the notifications list is open. */
  readonly isExpanded: boolean;
  /** The id of the element the notifications list mounts in. */
  readonly controlsId: string;
  readonly onToggle: () => void;
}

/** The entries to render, which one is current, and the acts of the rail's two controls. */
export interface NavigationRailProps {
  /** The destinations above the spacer, in rail order. */
  readonly entries: readonly RailEntry[];
  /** The Settings destination, at the rail's foot below the controls. */
  readonly settingsEntry: RailEntry;
  readonly current: RailDestination | undefined;
  readonly onSelect: (destination: RailDestination) => void;
  /**
   * The chord, printed for the host, that a destination's string ends in; a destination with none
   * has no suffix.
   */
  readonly chords: Readonly<Partial<Record<RailDestination, string>>>;
  readonly attention: RailAttentionControl;
  /** Steps the color scheme to the next in its cycle. */
  readonly onCycleColorScheme: () => void;
  /** Whether an update is staged and waiting for the restart, which marks Settings with a dot. */
  readonly isUpdateStaged: boolean;
}

/** The app's icon rail: the handed entries, the current one marked, and the two controls. */
export function NavigationRail(props: NavigationRailProps): React.JSX.Element {
  const { attention, settingsEntry } = props;
  const attentionName = attentionControlName(attention.count);
  return (
    <nav className="meridian-rail" aria-label="Console sections">
      <ul className="meridian-rail__list">
        {props.entries.map((entry) => (
          <li key={entry.destination} className="meridian-rail__item">
            <RailDestinationButton
              entry={entry}
              name={nameWithChord(entry.label, props.chords[entry.destination])}
              isCurrent={entry.destination === props.current}
              onSelect={props.onSelect}
            />
          </li>
        ))}
        <li className="meridian-rail__spacer" aria-hidden="true" />
        <li className="meridian-rail__item">
          <button
            type="button"
            className="meridian-rail__button"
            aria-label={attentionName}
            title={attentionName}
            aria-expanded={attention.isExpanded}
            aria-controls={attention.controlsId}
            onClick={attention.onToggle}
          >
            <Glyph name="bell" />
            {isAnythingWaiting(attention.count) ? (
              <span className="meridian-rail__pip" aria-hidden="true" />
            ) : null}
          </button>
        </li>
        <li className="meridian-rail__item">
          <button
            type="button"
            className="meridian-rail__button"
            aria-label={RAIL_CONTROL_LABELS.colorScheme}
            title={RAIL_CONTROL_LABELS.colorScheme}
            onClick={props.onCycleColorScheme}
          >
            <Glyph name="moon" />
          </button>
        </li>
        <li className="meridian-rail__item">
          <RailDestinationButton
            entry={settingsEntry}
            name={settingsName(
              nameWithChord(settingsEntry.label, props.chords[settingsEntry.destination]),
              props.isUpdateStaged,
            )}
            isCurrent={settingsEntry.destination === props.current}
            onSelect={props.onSelect}
          >
            {props.isUpdateStaged ? (
              <span className="meridian-rail__dot" aria-hidden="true" />
            ) : null}
          </RailDestinationButton>
        </li>
      </ul>
    </nav>
  );
}

/**
 * What each rail destination shows. A total `Record` over the destination union, so a new
 * destination fails to typecheck until it has an entry. Rail order is not here: it comes from the
 * `RAIL_DESTINATIONS` tuple where the entries are built (`destinations.ts`).
 */
export const RAIL_ENTRY_TEMPLATES: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  sessions: { label: "Sessions", glyph: "sessions" },
  // The robot the composer's agents badge draws: the one picture of an agent everywhere.
  sidekicks: { label: "Sidekicks", glyph: "agent" },
  skills: { label: "Skills", glyph: "skills" },
  // Reuses the `workflow` glyph: one picture per concept keeps the glyphs one set.
  workflows: { label: "Workflows", glyph: "workflow" },
  settings: { label: "Settings", glyph: "settings" },
};

/** The labels of the rail's two controls, which their palette rows share. */
export const RAIL_CONTROL_LABELS = {
  notifications: "Notifications",
  colorScheme: "Color scheme",
} as const;

interface RailDestinationButtonProps {
  readonly entry: RailEntry;
  /** The button's one string: its hover title and its spoken name. */
  readonly name: string;
  readonly isCurrent: boolean;
  readonly onSelect: (destination: RailDestination) => void;
  /** A mark drawn over the glyph, hidden from assistive technology. */
  readonly children?: React.ReactNode;
}

function RailDestinationButton(props: RailDestinationButtonProps): React.JSX.Element {
  const { entry } = props;
  return (
    <button
      type="button"
      className={
        props.isCurrent
          ? "meridian-rail__button meridian-rail__button--current"
          : "meridian-rail__button"
      }
      aria-current={props.isCurrent ? "page" : undefined}
      aria-label={props.name}
      title={props.name}
      onClick={() => {
        props.onSelect(entry.destination);
      }}
    >
      <Glyph name={entry.glyph} />
      {props.children}
    </button>
  );
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

function attentionControlName(count: number | undefined): string {
  const label = RAIL_CONTROL_LABELS.notifications;
  return isAnythingWaiting(count) ? `${label}, ${formatCount(count)} waiting` : label;
}
