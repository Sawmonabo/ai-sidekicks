// The lease line's one control: take the shell. It never derives the holder from the last take
// (the line moves when a `pty.control_changed` transition reaches the fold), never queues or
// retries one, and is absent while this device holds the shell, a run holds it, or this
// device's identity has not been read.

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
   * Which device this is. Without it no control is offered: the fold names holders by user id,
   * so a take could come back as a hold the line cannot recognize as this device's.
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
      className="meridian-lease-line__take meridian-action-button"
      onClick={takeShell.take}
      disabled={takeShell.isInFlight}
    >
      Take the shell
    </button>
  );
}
