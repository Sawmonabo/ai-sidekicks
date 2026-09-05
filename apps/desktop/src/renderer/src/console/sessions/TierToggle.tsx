import { type SessionPinTier } from "./rows/session-rows.js";

/**
 * The tier control.
 *
 * Labelled by the act rather than by the state, so a screen reader hears what
 * pressing it does. Revealed on hover and on `:focus-within` (see the stylesheet)
 * and never removed from the tab order while hidden, because a control a pointer
 * can reach and a keyboard cannot is not a control.
 */
export function TierToggle(props: {
  readonly sessionId: string;
  readonly tier: SessionPinTier;
  readonly onSetTier: (sessionId: string, tier: SessionPinTier) => void;
}): React.JSX.Element {
  const isPinnedToFront = props.tier === "front";
  const label = isPinnedToFront ? "Move to the back tier" : "Pin to the front tier";
  return (
    <button
      type="button"
      className="meridian-session-row__tier"
      aria-label={label}
      title={label}
      onClick={() => {
        props.onSetTier(props.sessionId, isPinnedToFront ? "back" : "front");
      }}
    >
      {isPinnedToFront ? "Unpin" : "Pin"}
    </button>
  );
}
