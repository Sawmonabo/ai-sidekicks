// One facet's value, in the provenance its form names.
//
// Its own module because a `.tsx` declares one component. It stays a sibling of
// `EntityRecord.tsx` rather than joining the record's own file or the family door:
// a caller that could render a facet on its own could render one outside a record,
// and the record is the thing that gives a facet its label — so this is reached by
// the record's deep import and by nothing else.

import { DerivedFigure, Nothing, WireFigure } from "../../../primitives/index.js";
import type { EntityFacet } from "./entity-facets.js";

/** One facet's value, drawn in the provenance its form names. */
export function EntityFacetValueView(props: { readonly facet: EntityFacet }): React.JSX.Element {
  const { value } = props.facet;
  if (value.form === "wire") {
    return <WireFigure value={value.text} />;
  }
  if (value.form === "derived") {
    return <DerivedFigure text={value.text} />;
  }
  return (
    <Nothing kind="not-checked" placement="inline" title="Not recorded" detail={value.detail} />
  );
}
