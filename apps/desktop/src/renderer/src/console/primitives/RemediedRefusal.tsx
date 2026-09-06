// A refusal rendered with the operator's next move beside it.
//
// `refusal-contract.ts` states the grammar and leaves `action` a slot the caller
// fills; `core/refusal-remedies.ts` is what the console knows to put in it. This
// component is the join, and it exists so the join happens once: every surface that
// renders a daemon refusal would otherwise look the code up and pick a shape itself,
// and three surfaces doing that is three chances to answer one code differently.
//
// IT RENDERS TWO OF THE THREE SHAPES AND NEVER THE THIRD. A banner spans the frame
// and belongs to the frame's own store, so a pane body drawing one would put a
// whole-room notice inside one pane. The remedy's `banner` rendering therefore
// draws the CARD here — the refusal still reaches the surface that produced it —
// and the escalation is a separate, explicit act by a surface that holds a frame
// store (`store/refusal-escalation.ts`). Splitting it that way is what keeps this a
// pure component and keeps the escalation somewhere a reader can find it.
//
// A CODE WITH NO REMEDY RENDERS EXACTLY AS IT DOES WITHOUT THIS COMPONENT: inline,
// with the daemon's code and sentence and no action. That is the honest default —
// most registered codes have no next move beyond what the daemon already said, and
// inventing one would be the console explaining what the daemon meant.

import { refusalRemedyFor, type ConsoleRefusal } from "../core/index.js";
import { InlineRefusal } from "./InlineRefusal.js";
import { RefusalCard } from "./RefusalCard.js";

export interface RemediedRefusalProps {
  readonly refusal: ConsoleRefusal;
  /**
   * Rendered after the console's own next move, for a surface that can say
   * something this table cannot — the failed bindings a goal mutation named, the
   * position a rewind landed at. Absent on most call sites.
   */
  readonly detailAction?: React.ReactNode;
}

/** The daemon's words, with the console's next move in the action slot. */
export function RemediedRefusal(props: RemediedRefusalProps): React.JSX.Element {
  const { refusal, detailAction } = props;
  const remedy = refusalRemedyFor(refusal.code);
  const action =
    remedy === undefined && detailAction === undefined ? undefined : (
      <>
        {remedy === undefined ? null : (
          <span className="meridian-refusal__next-move">{remedy.nextMove}</span>
        )}
        {detailAction}
      </>
    );
  if (remedy?.rendering === "card" || remedy?.rendering === "banner") {
    return <RefusalCard code={refusal.code} detail={refusal.detail} action={action} />;
  }
  return <InlineRefusal code={refusal.code} detail={refusal.detail} action={action} />;
}
