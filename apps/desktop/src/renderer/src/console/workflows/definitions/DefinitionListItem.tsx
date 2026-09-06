// One definition's row in the browser's list.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `DefinitionsBrowser.tsx`, which is the
// package's one-component-per-`.tsx` rule: a module holding three components is a
// module whose name answers for one of them, and the other two are reached only by
// reading the file. `primitives/ReadingNotice.tsx` is the precedent — a deep relative
// import from its host, and no door line, because nothing outside this family
// composes it.
//
// THE RESOLUTION ANSWER IS DISPLAYED, NEVER COMPUTED. `resolvesAtThisContext` arrives
// on the row as the daemon resolved it; a row that re-walked `session` → `project` →
// `shared` would be a second authority on a question the daemon owns, and the two
// would agree right up until a dedup or a scope reference made them disagree.

import { memo, useId } from "react";

import { Chip, WireFigure, formatCount } from "../../primitives/index.js";
import type { OpenDefinition, WorkflowDefinitionRow } from "./definition-rows.js";

interface DefinitionListItemProps {
  readonly definition: WorkflowDefinitionRow;
  /** Required-and-nullable rather than optional: every construction site sets it. */
  readonly onOpenDefinition: OpenDefinition | undefined;
}

/**
 * One definition's row.
 *
 * Memoized: the browser re-renders on every page of a cursor-paged fetch, and rows
 * already on screen have not changed. Row values are frozen wire summaries, so the
 * default shallow comparison is the right one.
 */
export const DefinitionListItem: React.MemoExoticComponent<
  (props: DefinitionListItemProps) => React.JSX.Element
> = memo(function DefinitionListItem(props: DefinitionListItemProps): React.JSX.Element {
  const { definition, onOpenDefinition } = props;
  const resolutionMarkId = useId();
  const resolvesHere = definition.resolvesAtThisContext;
  return (
    <li
      className={
        resolvesHere
          ? "meridian-definition-row meridian-definition-row--resolves"
          : "meridian-definition-row"
      }
      // The mark is announced as well as shown — a chip a screen reader reads as one
      // more label among several does not say what it is — but it is announced as a
      // DESCRIPTION and not as `aria-current`.
      //
      // `aria-current` marks the single current item within a set, and
      // `resolvesAtThisContext` is not that: it is an independent predicate per
      // definition NAME, so a scope holding resolving definitions for two names marks
      // two rows, and assistive technology then says "current" about several rows in
      // one list without saying what any of them is current for. Pointing the row's
      // description at the mark it already renders says the thing that is actually
      // true, in the words the surface already chose.
      aria-describedby={resolvesHere ? resolutionMarkId : undefined}
    >
      {onOpenDefinition === undefined ? (
        <span className="meridian-definition-row__name">{definition.name}</span>
      ) : (
        <button
          type="button"
          className="meridian-definition-row__name meridian-definition-row__open"
          onClick={() => {
            onOpenDefinition(definition);
          }}
        >
          {definition.name}
        </button>
      )}
      <Chip mono label={definition.scope} />
      <span className="meridian-definition-row__version">
        version{" "}
        <WireFigure
          value={formatCount(definition.latestVersionNumber)}
          title={`${definition.latestVersionNumber}`}
        />
      </span>
      {resolvesHere ? (
        // The wrapper exists to be referable by id and for nothing else, which is why
        // it generates no box: the mark's place on the row is a design decision, and a
        // span introduced to carry an attribute must not quietly move it.
        <span className="meridian-definition-row__resolution" id={resolutionMarkId}>
          {/*
           * NEUTRAL, and that is the whole of the treatment. Rule 3 spends the accent
           * on interactive affordances, and a resolution mark is a fact the daemon
           * reported about this row — nothing here is pressable, and the row's one
           * control is the name beside it. Toned accent, the mark advertised a
           * non-actionable reading as the thing to click.
           */}
          <Chip glyph="check" label="Resolves here" />
        </span>
      ) : null}
    </li>
  );
});
