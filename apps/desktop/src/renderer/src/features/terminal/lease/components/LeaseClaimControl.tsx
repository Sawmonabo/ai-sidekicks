// The lease line's one control: take the shell.
//
// Its prohibitions are each a line of code here rather than a note:
//
//   • **Never derives the holder from the last observed claim.** Pressing the
//     control calls the wire and then does nothing to the holder. The line moves
//     when a `pty.control_changed` transition reaches the fold, and not before.
//   • **Never offers a claim by the current holder.** A device that holds the shell
//     sees no control, so the idempotent self-claim — which succeeds and broadcasts
//     nothing — is not reachable from this surface at all.
//   • **Never queues a claim.** No retry, no timer, no wait list.
//   • **Never offers a claim it cannot attribute.** The control acts on this device's
//     behalf and the fold names the holder by user id, so until this device's
//     identity has been READ there is no control here at all, and no sentence about
//     one. `lease-acquisition.ts` owns that fold.

import { resolveTerminalClaimAffordance } from "../take-shell-availability.js";
import type { TerminalLeaseClaim } from "../hooks/useTakeShell.js";
import type { TerminalLeaseHolding } from "../lease-model.js";
import type { TerminalViewerIdentity } from "../hooks/useTerminalDeviceIdentity.js";

/** What the claim control needs: its call state, the holding, and which device this is. */
export interface LeaseClaimControlProps {
  /** The claim control's call state. */
  readonly claim: TerminalLeaseClaim;
  readonly holding: TerminalLeaseHolding;
  /**
   * Which device this is, which is what the control is gated on.
   *
   * The control acts on this device's behalf and the fold names the holder by user id,
   * so a surface that offered it without the identity would be offering a control it
   * cannot report the outcome of: a take would come back as a hold it could not
   * recognize.
   */
  readonly viewerIdentity: TerminalViewerIdentity;
}

/** The button that takes the shell, drawn only where this device may take it. */
export function LeaseClaimControl(props: LeaseClaimControlProps): React.JSX.Element | null {
  const { claim, holding, viewerIdentity } = props;
  if (resolveTerminalClaimAffordance({ holding, viewerIdentity }).control === "none") {
    return null;
  }
  return (
    <button
      type="button"
      className="meridian-lease-line__claim"
      onClick={claim.acquire}
      disabled={claim.isInFlight}
    >
      Take the shell
    </button>
  );
}
