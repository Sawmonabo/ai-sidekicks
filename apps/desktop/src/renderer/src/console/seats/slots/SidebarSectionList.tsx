// What an open sidebar section draws once it has rows: a count, groups, and rows.
//
// ONE BODY FOR THE GRAMMAR, three bodies for the vocabulary. The runs, approvals and
// agents sections each render the same three things and differ only in what their
// groups are called, what tone a group wears, and what a row says — so the markup and
// the class names live here and each section supplies a table. Three copies of this
// JSX is how the fourth section ships a row that is not keyboard-reachable, and the
// sheet beside it is written against these names for the same reason.
//
// IN `seats/` RATHER THAN IN THE SIDEBAR'S OWN FAMILY, because the three bodies belong
// to three different families and one view family may not import another. This is the
// layer that already owns the sidebar-section CONTRACT — the id set, the context, the
// descriptor and the registry — so the markup that contract implies belongs beside it
// and every family reads it through the one door. Parked in the composer family's
// subtree it would have been reachable by exactly one of its three callers.
//
// EVERY ROW IS A `<button>`, because pressing one performs an act — open the pane
// this row addresses — and a `<div>` with a click handler is an act nobody reaches
// with a keyboard.
//
// THE IDENTIFIER IS A WIRE FIGURE and the count is a DERIVED one, which is the
// provenance signature rule: the first is a value the daemon sent and the second is
// this console's own reading of how many rows survived a filter.

import {
  Chip,
  DerivedFigure,
  WireFigure,
  formatCount,
  type ChipTone,
} from "../../primitives/index.js";

/** One row: the entity it addresses, the state it is in, and how it opens. */
export interface SectionListRow {
  /**
   * React's key and the row's IDENTITY — the wire-verbatim id of the entity it opens.
   *
   * Identity and display are two questions, and a row that answers both with one
   * member answers neither: a section keying on a display name gives two same-named
   * entities in one group the same React key, and moves a stable entity's key the
   * moment somebody renames it. So the id stays the entity's own, and a name that is
   * worth showing rides {@link label} beside it.
   */
  readonly id: string;
  /**
   * The name the wire gave this entity, drawn in place of the id where there is one.
   *
   * Absent means the entity has no name to show and the id is what a reader gets,
   * which is what the console knows — a label invented from an id would be worse than
   * the id, because a reader could not tell the invention from a reading.
   */
  readonly label?: string;
  /** The row's wire-verbatim state, drawn as a mono chip beside the identifier. */
  readonly stateLabel: string;
  /** What a screen reader hears for the row's button, composed by the section. */
  readonly openLabel: string;
  /** Open the pane this row addresses. The section decides which; this file presses. */
  readonly open: () => void;
  /**
   * Bind this row's element as a drag source, where the section made it one.
   *
   * The binder is the COLUMN's — `SidebarSectionContext.dragRow` hands one down and it
   * is stable for a row id — so this is the ref callback and nothing else: no library,
   * no payload, and no cleanup lives here. Optional because a section whose rows open
   * nothing supplies none, and a row nobody bound is drawn exactly as it was.
   */
  readonly bindDrag?: (element: HTMLElement | null) => void;
}

/** One group of rows, with the words and the tone its heading wears. */
export interface SectionListGroup {
  readonly id: string;
  readonly label: string;
  readonly tone: ChipTone;
  readonly rows: readonly SectionListRow[];
}

export interface SidebarSectionListProps {
  /**
   * What the count line says — "4 runs", "2 approvals".
   *
   * The NOUN is the section's because only it knows what its rows are called; the
   * figure is composed here from the row count so no section spells the formatting
   * of a number of its own.
   */
  readonly countNoun: string;
  /** The groups to draw, already ordered and already non-empty. */
  readonly groups: readonly SectionListGroup[];
}

export function SidebarSectionList(props: SidebarSectionListProps): React.JSX.Element {
  const totalRowCount = props.groups.reduce((count, group) => count + group.rows.length, 0);

  return (
    <div className="meridian-section-list">
      <p className="meridian-section-list__count">
        <DerivedFigure text={`${formatCount(totalRowCount)} ${props.countNoun}`} />
      </p>
      {props.groups.map((group) => (
        <section className="meridian-section-list__group" key={group.id} aria-label={group.label}>
          <h3 className="meridian-section-list__group-heading">
            <Chip tone={group.tone} label={group.label} />
            <DerivedFigure text={formatCount(group.rows.length)} />
          </h3>
          <ul className="meridian-section-list__list">
            {group.rows.map((row) => (
              <li className="meridian-section-list__row" key={row.id}>
                <button
                  type="button"
                  className="meridian-section-list__open"
                  aria-label={row.openLabel}
                  // The same element carries the press and the drag, because they are
                  // two ways to perform one act — open what this row addresses. A
                  // separate drag handle beside the button would be a second control
                  // for one outcome, and one of the two would be keyboard-unreachable.
                  ref={row.bindDrag}
                  onClick={row.open}
                >
                  <span className="meridian-section-list__id">
                    {/* The name where the wire gave one, the id where it did not —
                        both wire values, so both go through the one figure that
                        renders a wire string verbatim. */}
                    <WireFigure value={row.label ?? row.id} />
                  </span>
                  <Chip mono label={row.stateLabel} tone={group.tone} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
