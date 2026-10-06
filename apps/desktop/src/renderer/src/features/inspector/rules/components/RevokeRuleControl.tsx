// The two-step control that retires one standing permission: the first press arms, the
// confirming press reaches the wire, and a control already revoking offers no second press.

import { Nothing } from "#renderer/components/Nothing/Nothing.js";

/**
 * Idle, confirming, pending: three states on one control.
 *
 * `onConfirm` is the only handler that calls the mutation, so canceling never mutates.
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
      <button
        className={
          "meridian-action-button " +
          "meridian-action-button--regular meridian-action-button--outline"
        }
        type="button"
        onClick={props.onAsk}
      >
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
      <button
        className={
          "meridian-action-button " +
          "meridian-action-button--regular meridian-action-button--outline"
        }
        type="button"
        onClick={props.onConfirm}
      >
        Revoke it
      </button>
      <button
        className={
          "meridian-action-button " +
          "meridian-action-button--regular meridian-action-button--outline"
        }
        type="button"
        onClick={props.onCancel}
      >
        Keep it
      </button>
    </div>
  );
}
