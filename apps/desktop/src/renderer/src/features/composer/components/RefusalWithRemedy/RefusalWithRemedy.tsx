// A refusal rendered with the person's next move beside it: the join of
// `components/Refusal/props.ts`, `lib/refusal/remedies.ts` and `RefusalRemedyContent`, so every
// view answers a code the same way. A `banner` remedy draws the card here, since a banner spans the
// frame and belongs to the frame's store; escalating is `hooks/useRefusalBannerEscalation.ts`. A
// code with no remedy renders inline with the daemon's words and no action, and the console invents
// no next move.

import { refusalRemedyFor, remedyWordsOf } from "#renderer/lib/refusal/remedies.js";
import { type ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { RefusalCard } from "#renderer/components/Refusal/RefusalCard.js";
import { RefusalRemedyContent } from "#renderer/components/Refusal/RefusalRemedyContent.js";

/** Props for `RefusalWithRemedy`. */
export interface RefusalWithRemedyProps {
  /** The refusal to draw. A new refusal object is a new attempt, said again in the same words. */
  readonly refusal: ExtendedRefusal;
}

/** The daemon's words, with the console's next move in the action row, read out after them. */
export function RefusalWithRemedy(props: RefusalWithRemedyProps): React.JSX.Element {
  const { refusal } = props;
  const remedy = refusalRemedyFor(refusal.code);
  const remedyWords = remedy === undefined ? undefined : remedyWordsOf(remedy);
  const action = remedy === undefined ? undefined : <RefusalRemedyContent remedy={remedy} />;
  if (remedy?.rendering === "card" || remedy?.rendering === "banner") {
    return (
      <RefusalCard
        code={refusal.code}
        reason={refusal.reason}
        detail={refusal.detail}
        action={action}
        remedyWords={remedyWords}
        attempt={refusal}
      />
    );
  }
  return (
    <InlineRefusal
      code={refusal.code}
      reason={refusal.reason}
      detail={refusal.detail}
      action={action}
      remedyWords={remedyWords}
      attempt={refusal}
    />
  );
}
