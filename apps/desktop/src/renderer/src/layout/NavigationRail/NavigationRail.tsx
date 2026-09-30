// The icon rail: a fixed set of destinations, always in the same place, so a person builds muscle
// memory. It renders exactly the entries it is handed and has no availability flag: an unreachable
// destination is absent, not disabled. It carries no color except the accent on the current one.

import type { GlyphName } from "@renderer/styles/glyphs.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import type { RailDestination } from "@renderer/routing/route-readers.js";

import "./navigation-rail.css";

/** What one destination shows. Availability is decided elsewhere. */
export interface RailEntryTemplate {
  readonly label: string;
  readonly glyph: GlyphName;
}

/** One rail destination with what it shows. */
export interface RailEntry extends RailEntryTemplate {
  readonly destination: RailDestination;
}

/** The entries to render, which one is current, and the selection callback. */
export interface NavigationRailProps {
  readonly entries: readonly RailEntry[];
  readonly current: RailDestination | undefined;
  readonly onSelect: (destination: RailDestination) => void;
}

/** The console's icon rail: one button per handed entry, the current one marked. */
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
 * What each rail destination shows. A total `Record` over the destination union, so a new
 * destination fails to typecheck until it has an entry. Rail order is not here: it comes from the
 * `RAIL_DESTINATIONS` tuple where the entries are built (`rail-navigation.ts`).
 */
export const RAIL_ENTRY_TEMPLATES: Readonly<Record<RailDestination, RailEntryTemplate>> = {
  sessions: { label: "Sessions", glyph: "sessions" },
  // Reuses the `workflow` glyph: one picture per concept keeps the glyphs one set.
  workflows: { label: "Workflows", glyph: "workflow" },
  settings: { label: "Settings", glyph: "settings" },
};
