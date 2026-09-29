// The icon rail: three destinations, always in the same place.
//
// The main window has a narrow rail with a fixed set of destinations. Fixed is the
// point — a rail whose contents change with context is a rail nobody builds muscle
// memory for, and the design's whole claim about the console is that a person stops
// looking for things.
//
// Two rules show up here in miniature:
//
//   • **Absent, not disabled.** A destination the window cannot reach is not
//     rendered greyed out; it is not rendered. This rail renders exactly the
//     entries it is handed and carries no availability flag of its own — an
//     unreachable destination is one its caller left out.
//   • **Quiet.** The rail carries no color except the accent on the current
//     destination. It is the console's most-seen surface, so it is the one that most
//     has to stay quiet.

import type { GlyphName } from "@renderer/console/primitives/index.js";
import { Glyph } from "@renderer/console/primitives/index.js";
import type { RailDestination } from "@renderer/routing/route-readers.js";

import "./navigation-rail.css";

/** What one destination shows. Availability is decided elsewhere. */
export interface RailEntryTemplate {
  readonly label: string;
  readonly glyph: GlyphName;
}

export interface RailEntry extends RailEntryTemplate {
  readonly destination: RailDestination;
}

export interface NavigationRailProps {
  readonly entries: readonly RailEntry[];
  readonly current: RailDestination | undefined;
  readonly onSelect: (destination: RailDestination) => void;
}

export function NavigationRail(props: NavigationRailProps): React.JSX.Element {
  return (
    <nav className="meridian-rail" aria-label="Console sections">
      <ul className="meridian-rail__list">
        {props.entries.map((entry) => {
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
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The rail's fixed contents, one entry per destination.
 *
 * A total `Record` over the destination union rather than an array, because "one
 * entry per destination" is a claim only an indexed table can hold: as an array it
 * enforced nothing, and a fourth `RailDestination` would have typechecked and
 * rendered nowhere — the exact failure `RAIL_DESTINATIONS` is a walkable tuple to
 * prevent, left open on the one table that consumes it.
 *
 * ORDER IS NOT HERE. A record's key order is an artefact of how it was written; the
 * rail's order is a design decision, so it is read from the `RAIL_DESTINATIONS`
 * tuple where the entries are built (`rail-navigation.ts`), not from this literal.
 */
export const RAIL_ENTRY_TEMPLATES: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  sessions: { label: "Sessions", glyph: "sessions" },
  // The `workflow` glyph the pane kind already uses, rather than a plural sibling
  // drawn beside it. One picture per concept is what makes the collection a family
  // — the destination and the pane it opens are the same thing at two scales, and
  // two glyphs for them would differ only by whoever drew the second one.
  workflows: { label: "Workflows", glyph: "workflow" },
  settings: { label: "Settings", glyph: "settings" },
};
