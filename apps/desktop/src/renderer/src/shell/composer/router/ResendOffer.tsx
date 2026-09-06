// The offer to send again what a settled send did not deliver.
//
// Split from `ComposerSendBar.tsx`, which owns the line and the act of sending,
// while this owns the one thing that can be true after a send has settled and the
// participant's words are still not on the wire.
//
// IT OFFERS AND NEVER RESENDS ON ITS OWN. The body it holds is the caller's, the
// act is the caller's, and a resend that fired without a press would be this
// surface deciding something the participant did not ask for.

/**
 * The tripwire card's one offer.
 *
 * A component rather than a conditional inside the card, so the body it resends is
 * captured once and cannot go stale between the render that showed the button and
 * the click that pressed it. No body to resend means no offer — never a button that
 * sends an empty message.
 */
export function ResendOffer(props: {
  readonly body: string | undefined;
  readonly onResend: (body: string) => Promise<void>;
}): React.JSX.Element | null {
  const { body, onResend } = props;
  if (body === undefined) {
    return null;
  }
  return (
    <button
      type="button"
      className="meridian-composer__resend"
      onClick={() => {
        void onResend(body);
      }}
    >
      Send again
    </button>
  );
}
