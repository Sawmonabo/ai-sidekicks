// The acceptance never reached the control plane: nobody decided anything, and the
// same act can be put again.
//
// NEITHER A JOIN NOR A REFUSAL, which is why it is its own reading. A refusal is an
// answer — the control plane looked at this invitation and said no — and this is the
// absence of one: the request did not arrive, so what a person is told is that
// nothing has happened to their invitation rather than that something has.
//
// THE OFFER TO TRY AGAIN IS THE WIRE'S, NOT THIS COMPONENT'S. The arm carries
// `retryable`, and the act it admits is the SAME confirmation on the same reference —
// so the card offers it and the main process decides whether the reference still
// resolves. Where it does not, the answer is the handle reading beside this one,
// which is what makes offering this safe rather than hopeful.
//
// NOTHING HERE DISPATCHES ANYTHING. The report owns the act row; this owns the words.

export function InviteAcceptanceUnavailableReading(): React.JSX.Element {
  return (
    <div className="meridian-invite-outcome__body">
      <h4 className="meridian-invite-outcome__title">This acceptance could not be sent.</h4>
      <p className="meridian-invite-outcome__lede">
        This window could not reach the control plane that issued the invitation, so nobody has
        decided anything about it. The invitation is untouched, and trying again costs it nothing.
      </p>
    </div>
  );
}
