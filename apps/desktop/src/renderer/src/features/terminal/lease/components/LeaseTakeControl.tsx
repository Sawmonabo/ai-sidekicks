// The lease line's one control: take the shell.
//
// Its prohibitions are each a line of code here rather than a note:
//
//   • **Never derives the holder from the last observed take.** Pressing the
//     control calls the wire and then does nothing to the holder. The line moves
//     when a `pty.control_changed` transition reaches the fold, and not before.
//   • **Never offers a take by the current holder.** A device that holds the shell
//     sees no control, so the idempotent self-take — which succeeds and broadcasts
//     nothing — is not reachable from the lease line at all.
//   • **Never queues a take.** No retry, no timer, no wait list.
//   • **Never offers a take it cannot attribute.** The control acts on this device's
//     behalf and the fold names the holder by user id, so until this device's
//     identity has been READ there is no control here at all, and no sentence about
//     one. `lease-acquisition.ts` owns that fold.

import { resolveTakeShellAvailability } from "../take-shell-availability.js";
import type { UseTakeShellResult } from "../hooks/useTakeShell.js";
import type { TerminalLeaseHolder } from "../lease-model.js";
import type { TerminalDeviceIdentity } from "../hooks/useTerminalDeviceIdentity.js";

/** What the take control needs: its call state, the holding, and which device this is. */
export interface LeaseTakeControlProps {
  /** The take control's call state. */
  readonly takeShell: UseTakeShellResult;
  readonly holding: TerminalLeaseHolder;
  /**
   * Which device this is, which is what the control is gated on.
   *
   * The control acts on this device's behalf and the fold names the holder by user id,
   * so a lease line that offered it without the identity would be offering a control it
   * cannot report the outcome of: a take would come back as a hold it could not
   * recognize.
   */
  readonly deviceIdentity: TerminalDeviceIdentity;
}

/** The button that takes the shell, drawn only where this device may take it. */
export function LeaseTakeControl(props: LeaseTakeControlProps): React.JSX.Element | null {
  const { takeShell, holding, deviceIdentity } = props;
  if (resolveTakeShellAvailability({ holding, deviceIdentity }).control === "none") {
    return null;
  }
  return (
    <button
      type="button"
      className="meridian-lease-line__take"
      onClick={takeShell.take}
      disabled={takeShell.isInFlight}
    >
      Take the shell
    </button>
  );
}
