// A refusal rendered with the person's next move beside it: the join of
// `components/Refusal/props.ts`, `lib/refusal/remedies.ts` and `RefusalRemedyContent`, so every
// view answers a code the same way. A `banner` remedy draws the card here, since a banner spans the
// frame and belongs to the frame's store; escalating is `hooks/useRefusalBannerEscalation.ts`. A
// code with no remedy renders inline with the daemon's words and no action, and the console invents
// no next move.

import { refusalRemedyFor } from "#renderer/lib/refusal/remedies.js";
import { type ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { RefusalCard } from "#renderer/components/Refusal/RefusalCard.js";
import { RefusalRemedyContent } from "#renderer/components/Refusal/RefusalRemedyContent.js";

/** Props for `RefusalWithRemedy`. */
export interface RefusalWithRemedyProps {
  readonly refusal: ExtendedRefusal;
  /**
   * Rendered inside the remedy region after the console's own next move, for a caller that can say
   * something the remedy table cannot, such as the position a rewind landed at.
   */
  readonly detailAction?: React.ReactNode;
  /** The attempt the refusal answers, so a retry refused the same way is said again. */
  readonly attempt?: unknown;
}

/** The daemon's words, with the console's next move in the action row. */
export function RefusalWithRemedy(props: RefusalWithRemedyProps): React.JSX.Element {
  const { refusal, detailAction, attempt } = props;
  const remedy = refusalRemedyFor(refusal.code);
  const action =
    remedy === undefined && detailAction === undefined ? undefined : (
      <RefusalRemedyContent remedy={remedy}>{detailAction}</RefusalRemedyContent>
    );
  if (remedy?.rendering === "card" || remedy?.rendering === "banner") {
    return (
      <RefusalCard
        code={refusal.code}
        reason={refusal.reason}
        detail={refusal.detail}
        action={action}
        attempt={attempt}
      />
    );
  }
  return (
    <InlineRefusal
      code={refusal.code}
      reason={refusal.reason}
      detail={refusal.detail}
      action={action}
      attempt={attempt}
    />
  );
}
