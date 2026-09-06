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
//     rendered greyed out; it is not rendered. This rail renders exactly the
//     entries it is handed and carries no availability flag of its own — an
//     unreachable destination is one its caller left out — and an auxiliary window
//     has no rail at all rather than a rail of dead icons.
//   • **The two-hue rule.** The rail carries no colour except the accent on the
//     current destination and, when something needs a person, one amber count. It
//     is the console's most-seen surface, so it is the one that most has to stay
//     quiet — which is also why the count is absent rather than zero when nothing
//     is waiting, and absent rather than stale when nothing is reading.

import type { GlyphName } from "../primitives/index.js";
import { Glyph } from "../primitives/index.js";
import type { RailDestination } from "../routing/index.js";

/** What one destination shows. Availability and attention are decided elsewhere. */
export interface RailEntryTemplate {
  readonly label: string;
  readonly glyph: GlyphName;
}

export interface RailEntry extends RailEntryTemplate {
  readonly destination: RailDestination;
  /**
   * How many things behind this destination are waiting for a person.
   *
   * A COUNT AND NOT A FLAG, which `Spec-023 §The surface set` asks for and which
   * the rail can honour without becoming a second source of truth: the number is
   * published by whoever performed the read, and this component renders it.
   * Absent means either nothing is waiting or nothing is currently reading — two
   * conditions the rail deliberately does not distinguish, because it has the same
   * thing to say about both: nothing.
   */
  readonly attentionCount?: number;
}

export interface IconRailProps {
  readonly entries: readonly RailEntry[];
  readonly current: RailDestination | undefined;
  readonly onSelect: (destination: RailDestination) => void;
}

export function IconRail(props: IconRailProps): React.JSX.Element {
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
                aria-label={
                  entry.attentionCount === undefined
                    ? entry.label
                    : `${entry.label}, ${String(entry.attentionCount)} waiting`
                }
                title={entry.label}
                onClick={() => {
                  props.onSelect(entry.destination);
                }}
              >
                <Glyph name={entry.glyph} />
                {entry.attentionCount === undefined ? null : (
                  // `aria-hidden`, because the number is already in the button's
                  // accessible name above: read out twice a reader hears the label,
                  // then the label again with a bare number after it.
                  <span className="meridian-rail__attention" aria-hidden="true">
                    {entry.attentionCount}
                  </span>
                )}
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
