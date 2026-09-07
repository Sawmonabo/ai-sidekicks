// Authentication stands between this person and the session.
//
// TWO ARMS IN ONE READING, because the difference between them is one sentence and
// one field: whether an attempt was made and failed, or whether none has been made
// yet. Both are answered by the same second attempt, so splitting them would be two
// copies of one control — and neither is a refusal, which is why they are not
// rendered as one.
//
// THE INVITATION IS STILL GOOD ON BOTH ARMS, and both say so. That is the fact a
// person needs: the reason to try again is that nothing about the invitation has
// changed, and a reading that led with the failure would suggest otherwise.

import type { GrowthInviteOutcome } from "../../bridge/index.js";

export interface InviteAuthenticationReadingProps {
  readonly outcome: Extract<
    GrowthInviteOutcome,
    { readonly kind: "authentication-required" | "authentication-failed" }
  >;
}

export function InviteAuthenticationReading(
  props: InviteAuthenticationReadingProps,
): React.JSX.Element {
  const { outcome } = props;
  return (
    <div className="meridian-invite-outcome__body">
      <h4 className="meridian-invite-outcome__title">
        {outcome.kind === "authentication-required"
          ? "Sign in to finish joining."
          : "Signing in did not finish."}
      </h4>
      <p className="meridian-invite-outcome__lede">
        {outcome.kind === "authentication-required"
          ? "The invitation is good. This window is not signed in to the control plane that issued it, so accepting it needs an account first."
          : "The invitation is still good. What failed was the sign-in, and it can be attempted again."}
      </p>
      {outcome.kind === "authentication-failed" ? (
        <p className="meridian-invite-outcome__wire">
          <span className="meridian-invite-outcome__detail">{outcome.detail}</span>
        </p>
      ) : null}
    </div>
  );
}
