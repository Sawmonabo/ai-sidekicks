// What stands where the claim control would be.
//
// Its own module rather than a section of `LeaseLine.tsx`, because it is the whole of
// the console's refusal grammar applied to one affordance: the three things a console
// draws when it cannot offer a control are an absence, a refusal, and a statement, and
// which one this is depends on how the lease surface's one read settled.
// `lease-acquisition.ts` decides that; this renders it.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import type { TerminalClaimWithholding } from "./lease-acquisition.js";

/**
 * What stands where the claim control would be, and why there is none.
 *
 * Two reasons and two renderings, and both are about this window rather than about
 * anything anyone else is doing. An ABSENCE is a state nothing has established yet —
 * the identity read still in flight — and it says so in words. A REFUSAL is the wire's
 * own code and sentence, verbatim, with the console's next move in the primitive's
 * `action` slot rather than folded into the daemon's text.
 *
 * Neither arm leaves a disabled button behind. A `disabled` claim reads as "not right
 * now" when the truth is that the console does not yet know which window would be
 * claiming.
 */
export function WithheldClaimControl(props: {
  readonly withheld: TerminalClaimWithholding;
}): React.JSX.Element {
  const withheld = props.withheld;
  switch (withheld.reason) {
    case "identity-refused":
      return (
        <InlineRefusal
          code={withheld.refusal.code}
          detail={withheld.refusal.detail}
          action="Claiming the shell is offered again once the console can say which window this is."
        />
      );
    case "identity-not-read":
      return (
        <Nothing
          kind="not-loaded"
          placement="inline"
          title="Reading which window this is"
          detail="Claiming the shell needs to know which window is asking, because the lease names its holder and the surface would have no way to tell this window's hold from another's."
        />
      );
  }
}
