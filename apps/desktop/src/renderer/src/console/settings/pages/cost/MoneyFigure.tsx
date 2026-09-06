// A cents figure drawn as money.
//
// Its own module because the amount column of every split and the page's own figure
// line all read it: a component three modules import is not a helper hiding at the
// bottom of one of them.

import type { ReactNode } from "react";

import { WireFigure } from "../../../primitives/index.js";
import { formatCentsAsCurrency } from "./cost-receipt-model.js";

/**
 * A cents figure as money, with the daemon's own integer on the title — where the
 * eight rules put the number a formatted figure would otherwise hide. Four call
 * sites, so it is written once.
 */
export function MoneyFigure(props: { readonly cents: number }): ReactNode {
  return <WireFigure value={formatCentsAsCurrency(props.cents)} title={String(props.cents)} />;
}
