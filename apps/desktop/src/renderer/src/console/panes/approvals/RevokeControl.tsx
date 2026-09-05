// The two-step control that retires one standing permission.
//
// Split from `RememberedGrants.tsx`, which owns the audit list, while this owns the
// only act that list offers.
//
// TWO STEPS, AND THE SECOND IS THE ONE THAT FIRES. Revocation is not reversible
// from this surface, so the first press only arms; the confirming press is the one
// that reaches the wire, and a control that is already revoking says so rather than
// offering a second press that would.

import { Nothing } from "../../primitives/index.js";

/**
 * Idle, confirming, pending — three states on one control.
 *
 * `onConfirm` is the only handler that calls the mutation, which is what makes
 * "cancelling returns to idle with zero mutations" a fact about the code rather
 * than a claim about it.
 */
export function RevokeControl(props: {
  readonly isConfirming: boolean;
  readonly isRevoking: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  if (props.isRevoking) {
    return <Nothing kind="computing" placement="inline" title="Revoking this permission." />;
  }
  if (!props.isConfirming) {
    return (
      <button className="meridian-grants__revoke" type="button" onClick={props.onAsk}>
        Revoke
      </button>
    );
  }
  return (
    <div className="meridian-grants__confirm" role="group" aria-label="Confirm the revocation">
      <span className="meridian-grants__confirm-copy">
        Revoke this permission? The next matching request will be asked again.
      </span>
      <button className="meridian-grants__revoke" type="button" onClick={props.onConfirm}>
        Revoke it
      </button>
      <button className="meridian-grants__cancel" type="button" onClick={props.onCancel}>
        Keep it
      </button>
    </div>
  );
}
