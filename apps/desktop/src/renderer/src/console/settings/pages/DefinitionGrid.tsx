// A two-column definition list: a term, and what it means.
//
// Two settings pages state a closed set and explain each member of it — the account
// page for the vocabularies a registry row speaks, the cost page for the three ways
// one figure is split. Written twice that is one grid whose markup drifts, so it is
// written once here, on `apps/desktop/AGENTS.md`'s hoist-on-the-second-use rule.
//
// WHY THE TERM IS A NODE AND NOT A STRING
//
// One caller's terms are values the daemon sends and render through `WireFigure` —
// verbatim, in mono, never re-cased. The other's are the console's own words. That
// difference is the whole reason this cannot be the `__facts` grid, whose `dt`
// upper-cases its terms: upper-casing a wire string breaks the rule that a wire
// string renders exactly as it arrived. So the caller supplies the term already
// rendered, and this component decides only the layout.
//
// It renders the LIST and not the block around it. Every settings page writes its
// own `section` and heading, which is the family's shipped shape, and a component
// that swallowed those would be a second way to build a settings block.

import type { ReactNode } from "react";

/** One row: what is being named, and what it means. */
export interface DefinitionGridEntry {
  /**
   * The row's identity, stable across renders. Not derived from `term`, which is a
   * node and would force a caller with a rendered term to key on its own text
   * twice.
   */
  readonly key: string;
  readonly term: ReactNode;
  readonly definition: ReactNode;
}

export interface DefinitionGridProps {
  readonly entries: readonly DefinitionGridEntry[];
}

export function DefinitionGrid(props: DefinitionGridProps): ReactNode {
  return (
    <dl className="meridian-settings-page__vocabulary">
      {props.entries.map((entry) => (
        // `display: contents` on the wrapper, so the pair lands in the grid's own
        // two tracks and every definition shares one left edge.
        <div className="meridian-settings-page__vocabulary-entry" key={entry.key}>
          <dt>{entry.term}</dt>
          <dd>{entry.definition}</dd>
        </div>
      ))}
    </dl>
  );
}
