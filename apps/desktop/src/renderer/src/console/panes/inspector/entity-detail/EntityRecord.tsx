// One entity's record, drawn once for all twelve kinds.
//
// Every detail component supplies WHAT its kind carries and WHAT each of its four
// states says; this module decides how any of that looks. The split is the reason
// twelve kinds do not become twelve layouts: a kind that drew its own frame would
// pick its own heading weight, its own facet alignment, and its own answer to where
// the identifier goes, and a reader moving between two panes would be reading two
// consoles.
//
// THE FOUR ARMS, IN THIS ORDER, AND THE ORDER IS THE CLAIM.
//
//   1. **The read has not answered.** `not-loaded`. Nothing is known, so nothing is
//      said — a sentence here would be replaced a beat later.
//   2. **The projection is known-incomplete.** `error`, carrying the store's own
//      word for why plus what an incomplete projection costs THIS kind. It is
//      ranked above the absence arm deliberately: while the projection is
//      incomplete, a missing record is not evidence that there is no record, and a
//      pane that said "there is none" here would be asserting a fact the daemon has
//      explicitly withdrawn.
//   3. **Answered, and there is no such record.** `empty`, in the kind's own words.
//      The one arm allowed to say a record is not there.
//   4. **There is a record.** The record.
//
// `Spec-023 §Meridian, the design language` rule 8 is what makes them four rather
// than two — "A renderer that collapses two of these into one is wrong". That the
// second is a RANK on the record rather than a replacement for it is this console's
// own rule, because no committed document states it.

import { Chip, DerivedFigure, Glyph, Nothing, WireFigure } from "../../../primitives/index.js";
import type { GlyphName } from "../../../primitives/index.js";
import { EntityFacetValueView } from "./EntityFacetValueView.js";
import type { EntityFacet, ProjectionDegradedCause } from "./entity-facets.js";

/** Edge length the record's kind glyph is drawn at, matching the pane header's. */
const RECORD_GLYPH_SIZE = 14;

export interface EntityRecordProps {
  /** The kind's glyph, from the token family's set. */
  readonly glyph: GlyphName;
  /** What this kind is called, in the console's own words — "Run", "Workflow run". */
  readonly heading: string;
  /** The identifier the deck addressed, wire-verbatim. */
  readonly entityId: string;
  /** The record's headline state, wire-verbatim, where the projection carries one. */
  readonly state: string | undefined;
  readonly isInitialised: boolean;
  /** Whether the store holds a record for this identifier. */
  readonly hasRecord: boolean;
  readonly degradedCause: ProjectionDegradedCause | undefined;
  /**
   * What an incomplete projection costs this kind, as the second half of a
   * sentence beginning "The projection is incomplete (…), so ". The kind supplies
   * it because the cost differs: a partial run list is a wrong count, a partial
   * artifact record is a wrong size.
   */
  readonly degradedConsequence: string;
  /** What it means, in this kind's words, that the store answered and holds none. */
  readonly absentTitle: string;
  readonly absentDetail: string;
  readonly facets: readonly EntityFacet[];
  readonly linkedSourcePaneId: string | undefined;
  /** Anything the kind states beyond its facets. */
  readonly children?: React.ReactNode;
}

export function EntityRecord(props: EntityRecordProps): React.JSX.Element {
  const subject = props.heading.toLowerCase();
  if (!props.isInitialised) {
    return (
      <Nothing kind="not-loaded" placement="surface" title={`Reading the ${subject} record.`} />
    );
  }
  if (props.degradedCause !== undefined) {
    return (
      <Nothing
        kind="error"
        placement="surface"
        title={`The ${subject} record is incomplete.`}
        // The cause is the store's own word, rendered as received. The console
        // does not paraphrase it, and it offers no Retry: nothing reachable from
        // an inspector re-pulls a session.
        detail={`The projection is incomplete (${props.degradedCause}), so ${props.degradedConsequence}`}
      />
    );
  }
  if (!props.hasRecord) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title={props.absentTitle}
        detail={props.absentDetail}
      />
    );
  }
  return (
    <article className="meridian-entity-record" aria-label={`${props.heading} record`}>
      <header className="meridian-entity-record__head">
        <span className="meridian-entity-record__glyph">
          <Glyph name={props.glyph} size={RECORD_GLYPH_SIZE} />
        </span>
        <h2 className="meridian-entity-record__heading">{props.heading}</h2>
        <WireFigure value={props.entityId} />
        {props.state === undefined ? null : <Chip tone="neutral" mono label={props.state} />}
      </header>
      <dl className="meridian-entity-record__facets">
        {props.facets.map((facet) => (
          <div className="meridian-entity-record__facet" key={facet.label}>
            <dt className="meridian-entity-record__label">{facet.label}</dt>
            <dd className="meridian-entity-record__value">
              <EntityFacetValueView facet={facet} />
            </dd>
          </div>
        ))}
      </dl>
      {props.children}
      {props.linkedSourcePaneId === undefined ? null : (
        <p className="meridian-entity-record__link">
          Linked to the pane it was opened from — <DerivedFigure text={props.linkedSourcePaneId} />.
          Closing that pane does not close this one.
        </p>
      )}
    </article>
  );
}
