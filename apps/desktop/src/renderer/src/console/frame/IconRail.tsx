// The icon rail: three destinations, always in the same place.
//
// `Spec-023 §Console Design (Meridian)` §The surface set gives the main window a
// narrow rail with a fixed set of destinations. Fixed is the point — a rail whose
// contents change with context is a rail nobody builds muscle memory for, and the
// design's whole claim about the console is that a person stops looking for things.
//
// Two rules show up here in miniature:
//
//   • **Absent, not disabled.** A destination the window cannot reach is not
//     rendered greyed out; it is not rendered. An auxiliary window has no rail at
//     all rather than a rail of dead icons.
//   • **The two-hue rule.** The rail carries no colour except the accent on the
//     current destination and, when something needs a person, one amber dot. It is
//     the console's most-seen surface, so it is the one that most has to stay quiet.

import type { GlyphName } from "../primitives/index.js";
import { Glyph } from "../primitives/index.js";
import type { RailDestination } from "../routing/index.js";

export interface RailEntry {
  readonly destination: RailDestination;
  readonly label: string;
  readonly glyph: GlyphName;
  /** True when this destination has something waiting for a person (amber). */
  readonly needsAttention?: boolean;
  /** False hides the entry entirely — absent, never disabled. */
  readonly isAvailable: boolean;
}

export interface IconRailProps {
  readonly entries: readonly RailEntry[];
  readonly current: RailDestination | undefined;
  readonly onSelect: (destination: RailDestination) => void;
}

export function IconRail(props: IconRailProps): React.JSX.Element {
  const available = props.entries.filter((entry) => entry.isAvailable);
  return (
    <nav className="meridian-rail" aria-label="Console sections">
      <ul className="meridian-rail__list">
        {available.map((entry) => {
          const isCurrent = entry.destination === props.current;
          return (
            <li key={entry.destination} className="meridian-rail__item">
              <button
                type="button"
                className={
                  isCurrent
                    ? "meridian-rail__button meridian-rail__button--current"
                    : "meridian-rail__button"
                }
                aria-current={isCurrent ? "page" : undefined}
                aria-label={entry.label}
                title={entry.label}
                onClick={() => {
                  props.onSelect(entry.destination);
                }}
              >
                <Glyph name={entry.glyph} />
                {entry.needsAttention === true ? (
                  // A dot rather than a count: the rail says "someone is waiting",
                  // and the surface says how many. Two places showing the same
                  // number is two places that can disagree.
                  <span className="meridian-rail__attention" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The rail's fixed contents. Availability is decided by the frame, not here. */
export const RAIL_ENTRY_TEMPLATE: readonly Omit<RailEntry, "isAvailable" | "needsAttention">[] = [
  { destination: "sessions", label: "Sessions", glyph: "sessions" },
  { destination: "workspace", label: "Workspace", glyph: "workspace" },
  { destination: "settings", label: "Settings", glyph: "settings" },
];
