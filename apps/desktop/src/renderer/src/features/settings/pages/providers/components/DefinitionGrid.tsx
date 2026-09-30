// A two-column definition list: a term, and what it means.
//
// The term is a node, not a string: one caller's terms are wire values rendered through
// `WireFigure` (verbatim, in mono, never re-cased) and another's are the console's own words,
// so this cannot be the `__facts` grid, whose `dt` upper-cases. It renders the list and not the
// block around it; every settings page writes its own `section` and heading.

import type { ReactNode } from "react";

/** One row: what is being named, and what it means. */
export interface DefinitionGridEntry {
  /** The row's identity, stable across renders; not derived from `term`, which is a node. */
  readonly key: string;
  readonly term: ReactNode;
  readonly definition: ReactNode;
}

/** Props for {@link DefinitionGrid}. */
export interface DefinitionGridProps {
  readonly entries: readonly DefinitionGridEntry[];
}

/** A definition list of terms and what each means. */
export function DefinitionGrid(props: DefinitionGridProps): ReactNode {
  return (
    <dl className="meridian-settings-page__vocabulary">
      {props.entries.map((entry) => (
        // `display: contents` on the wrapper puts the pair in the grid's own two tracks.
        <div className="meridian-settings-page__vocabulary-entry" key={entry.key}>
          <dt>{entry.term}</dt>
          <dd>{entry.definition}</dd>
        </div>
      ))}
    </dl>
  );
}
