// One facet's value, in the provenance its form names. Reached only from `EntityRecord.tsx`,
// which gives a facet its label.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { EntityFacet } from "../facets.js";

/** One facet's value, drawn in the provenance its form names. */
export function EntityFacetValueView(props: { readonly facet: EntityFacet }): React.JSX.Element {
  const { value } = props.facet;
  if (value.form === "wire") {
    return <WireFigure value={value.text} />;
  }
  if (value.form === "derived") {
    return <DerivedFigure text={value.text} />;
  }
  if (value.form === "instant") {
    return (
      <>
        <WireFigure value={value.clockText} hoverLabel={value.zonedText} /> ·{" "}
        <WireFigure value={value.text} hoverLabel={value.zonedText} />
      </>
    );
  }
  return (
    <Nothing kind="not-checked" placement="inline" title="Not recorded" detail={value.detail} />
  );
}
