// One entity's record, drawn once for every kind.
//
// Each detail supplies what its kind carries and what its four states say; this module decides
// how any of it looks, so kinds do not become one layout each.

import "./EntityRecord.css";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
// The kind glyph is drawn at the pane header's scale, taken from its one home.
import { GLYPH_SIZE_CHROME, type GlyphName } from "#renderer/styles/glyphs.js";
import { EntityFacetValueView } from "./EntityFacetValueView.js";
import type { SessionDegradedCause } from "#renderer/store/session/degradation.js";
import type { EntityFacet } from "../facets.js";

/** What one entity record draws: identity, facets, and the wording of its empty-state arms. */
export interface EntityRecordProps {
  /** The kind's glyph, from the app's glyph set. */
  readonly glyph: GlyphName;
  /** What this kind is called, in the app's own words — "Run", "Workflow run". */
  readonly heading: string;
  /** The identifier the pane layout addressed, wire-verbatim. */
  readonly entityId: string;
  /** The record's headline state as the wire spells it, where the projection carries one. */
  readonly state: string | undefined;
  readonly isInitialized: boolean;
  /** Whether the store holds a record for this identifier. */
  readonly hasRecord: boolean;
  readonly degradedCause: SessionDegradedCause | undefined;
  /**
   * What an incomplete projection costs this kind, as the second half of a sentence beginning
   * "The projection is incomplete (…), so ": a partial run list is a wrong count, a partial
   * artifact record a wrong size.
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

/**
 * One entity's record. The arms rank: read not answered, then projection incomplete (above
 * the absent arm, since a missing record proves nothing while incomplete), then absent, then the
 * record.
 */
export function EntityRecord(props: EntityRecordProps): React.JSX.Element {
  const subject = props.heading.toLowerCase();
  if (!props.isInitialized) {
    return <Nothing kind="not-loaded" placement="block" title={`Reading the ${subject} record.`} />;
  }
  if (props.degradedCause !== undefined) {
    return (
      <Nothing
        kind="error"
        placement="block"
        title={`The ${subject} record is incomplete.`}
        // No Retry: nothing reachable from an inspector re-pulls a session.
        detail={
          // Lower case, as the cause's words stand mid-sentence.
          `The projection is incomplete (${codeWords(props.degradedCause).toLowerCase()}), ` +
          `so ${props.degradedConsequence}`
        }
      />
    );
  }
  if (!props.hasRecord) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title={props.absentTitle}
        detail={props.absentDetail}
      />
    );
  }
  return (
    <article className="meridian-entity-record" aria-label={`${props.heading} record`}>
      <header className="meridian-entity-record__head">
        <span className="meridian-entity-record__glyph">
          <Glyph name={props.glyph} size={GLYPH_SIZE_CHROME} />
        </span>
        <h2 className="meridian-entity-record__heading">{props.heading}</h2>
        <WireFigure value={props.entityId} title={props.entityId} truncate />
        {props.state === undefined ? null : <Chip tone="neutral" label={codeWords(props.state)} />}
      </header>
      <dl className="meridian-entity-record__facets">
        {props.facets.map((facet) => (
          <div className="meridian-entity-record__facet" key={facet.label}>
            <dt className="meridian-entity-record__label">{facet.label}</dt>
            <dd className="meridian-entity-record__value" title={fullTextOf(facet)}>
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

// The whole value, for the hover title of a value cut short; an unrecorded one carries its own.
function fullTextOf(facet: EntityFacet): string | undefined {
  return facet.value.form === "unrecorded" ? undefined : facet.value.text;
}
