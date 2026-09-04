// What stands where the claim control would be.
//
// Its own module rather than a section of `LeaseLine.tsx`, because it is the whole of
// `Spec-023 §Console Design (Meridian)` rule 9 applied to one affordance: the three
// things a console draws when it cannot offer a control are an absence, a refusal,
// and a statement, and which one this is depends on which of the lease surface's two
// reads is missing. `lease-acquisition.ts` decides that; this renders it.

import { InlineRefusal, Nothing, WireFigure } from "../primitives/index.js";
import type { TerminalClaimWithholding } from "./lease-acquisition.js";

/**
 * What stands where the claim control would be, and why there is none.
 *
 * Six reasons and three renderings, because rule 9 draws exactly three things. An
 * ABSENCE is a state nothing has established yet — the two reads still in flight, and
 * a roster that names no role — and it says so in words. A REFUSAL is the wire's own
 * code and sentence, verbatim, with the console's next move in the primitive's
 * `action` slot rather than folded into the daemon's text. And a role that simply may
 * not take the shell is neither: nothing failed and nothing is pending, so it takes a
 * designed statement of what this window can do here.
 *
 * No arm leaves a disabled button behind. A `disabled` claim reads as "not right now"
 * when the truth is either that the console does not know who would be claiming or
 * that this participant may not claim at all.
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
          action="Claiming the shell is offered again once the console can say which participant this window is."
        />
      );
    case "role-refused":
      return (
        <InlineRefusal
          code={withheld.refusal.code}
          detail={withheld.refusal.detail}
          action="Claiming the shell is offered again once the console can say what this window's participant may do."
        />
      );
    case "identity-not-read":
      return (
        <Nothing
          kind="not-loaded"
          placement="inline"
          title="Reading who you are"
          detail="Claiming the shell needs to know which participant this window is, because the lease names its holder and the surface would have no way to tell your hold from somebody else's."
        />
      );
    case "role-not-read":
      return (
        <Nothing
          kind="not-loaded"
          placement="inline"
          title="Reading what you may do"
          detail="Taking the shared shell is open to owners and collaborators, and the console is still reading which of them this window's participant is."
        />
      );
    case "role-unread-in-roster":
      return (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Your role is not in the roster"
          detail="The roster this session's log has built names no role for this window's participant, so the console cannot say whether taking the shell is open to you. That is not the same as being refused it."
        />
      );
    case "role-cannot-acquire":
      return (
        <p className="meridian-lease-line__aside">
          Taking the shared shell is open to owners and collaborators. You are here as a{" "}
          <WireFigure value={withheld.role} />, so this pane watches the shell rather than typing
          into it.
        </p>
      );
  }
}
