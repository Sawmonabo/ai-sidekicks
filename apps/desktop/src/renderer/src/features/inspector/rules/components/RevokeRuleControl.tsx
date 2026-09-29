// The two-step control that retires one standing permission.
//
// Split from `RememberedRules.tsx`, which owns the audit list, while this owns the
// only act that list offers.
//
// TWO STEPS, AND THE SECOND IS THE ONE THAT FIRES. Revocation is not reversible
// from the rules list, so the first press only arms; the confirming press is the one
// that reaches the wire, and a control that is already revoking says so rather than
// offering a second press that would.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";

/**
 * Idle, confirming, pending — three states on one control.
 *
 * `onConfirm` is the only handler that calls the mutation, which is what makes
 * "canceling returns to idle with zero mutations" a fact about the code rather
 * than a claim about it.
 */
export function RevokeRuleControl(props: {
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
      <button className="meridian-remembered-rules__revoke" type="button" onClick={props.onAsk}>
        Revoke
      </button>
    );
  }
  return (
    <div
      className="meridian-remembered-rules__confirm"
      role="group"
      aria-label="Confirm the revocation"
    >
      <span className="meridian-remembered-rules__confirm-copy">
        Revoke this permission? The next matching request will be asked again.
      </span>
      <button className="meridian-remembered-rules__revoke" type="button" onClick={props.onConfirm}>
        Revoke it
      </button>
      <button className="meridian-remembered-rules__cancel" type="button" onClick={props.onCancel}>
        Keep it
      </button>
    </div>
  );
}
