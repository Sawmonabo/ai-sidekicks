// Why the paying-account chip cannot name an account.
//
// A SEPARATE MODULE FOR THE REASON `PayingAccount.tsx` IS ONE. That component's own
// header says four absence arms inside another component is where an author
// eventually collapses two of them, and the refusal is three arms by itself: no
// reason carried, a wire this build does not have, and a read that failed and said
// why. Rule 8 forbids collapsing any two of those, so they get a file.
//
// THE UNBUILT WIRE IS NOT AN ERROR. `growth-port.ts`'s own header says a live bridge
// refusing an unregistered wire "renders as the 'not checked' kind of nothing …
// never as an empty list", and this chip rendered it as an inline refusal — an alert
// glyph and a mono code beside a chip, for a question this build never put. The
// distinction is the whole of rule 8: nobody asked is not the same fact as the
// answer failed, and only the second is something a person can act on.
//
// EVERY ARM IS MOUNTED INLINE, because the chip rail is a row of chips and an
// absence that qualifies one of them sits beside it. `Nothing`'s own note says kind
// is what is absent and placement is where it is mounted, so the kind carries the
// treatment rule 8 gives it and the rail decides the box.

import { isUnbuiltWireRefusal } from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import { InlineRefusal, Nothing } from "../../../console/primitives/index.js";

/** What is absent, worded once so all three arms say the same thing is missing. */
const PAYING_ACCOUNT_NOT_READ = "Paying account not read";

export interface PayingAccountRefusalProps {
  /** The reason the reading carried, or `undefined` when it carried none. */
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * The reason no paying account is named, in the shape that reason deserves.
 *
 * TAKING `undefined` IS THE POINT OF THE PROP'S TYPE. A reading whose phase says
 * refused is refused whether or not a reason travelled with it, and the caller that
 * had to test for one before rendering anything fell through to an arm claiming the
 * roster HAD answered. So the presence of a reason chooses the sentence here; it
 * never decides whether an absence is rendered at all.
 */
export function PayingAccountRefusal(props: PayingAccountRefusalProps): React.JSX.Element {
  const { refusal } = props;
  if (refusal === undefined) {
    return (
      <Nothing
        kind="error"
        placement="inline"
        title={PAYING_ACCOUNT_NOT_READ}
        detail="The agent roster read refused and carried no reason."
      />
    );
  }
  if (isUnbuiltWireRefusal(refusal)) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title={PAYING_ACCOUNT_NOT_READ}
        detail={refusal.detail}
      />
    );
  }
  return <InlineRefusal code={refusal.code} detail={refusal.detail} />;
}
