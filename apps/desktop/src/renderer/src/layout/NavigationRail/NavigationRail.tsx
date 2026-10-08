// The icon rail: the destinations, a spacer, the attention and color-scheme controls, then Settings
// at the foot, always in the same place, so a person builds muscle memory. It renders exactly the
// entries it is handed and has no availability flag: an unreachable destination is absent, not
// disabled. It carries no color except the accent on the current destination and on the bell while
// its list is open, and two marks: the attention pip and the Settings dot. Each control has one
// string, its hover title and its spoken name at once.

import type { GlyphName } from "#renderer/styles/glyphs.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import type { RailDestination } from "#renderer/routing/readers.js";
import { RAIL_CONTROL_LABELS } from "./control-labels.js";
import { useRailNames } from "./hooks/useRailNames.js";

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
  const names = useRailNames(props);
  return (
    <nav className="meridian-rail" aria-label="Console sections">
      <ul className="meridian-rail__list">
        {names.namedEntries.map(({ entry, name }) => (
          <li key={entry.destination} className="meridian-rail__item">
            <RailDestinationButton
              entry={entry}
              name={name}
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
            aria-label={names.attentionName}
            title={names.attentionName}
            aria-expanded={attention.isExpanded}
            aria-controls={attention.controlsId}
            onClick={attention.onToggle}
          >
            <Glyph name="bell" />
            {names.pipFigure === undefined ? null : (
              <span className="meridian-rail__pip" aria-hidden="true">
                {names.pipFigure}
              </span>
            )}
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
            name={names.settingsName}
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
