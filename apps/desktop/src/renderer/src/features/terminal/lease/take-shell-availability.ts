// Whether this device may take the shell.
//
// There is no entitlement axis: the shell belongs to the one person using this machine, so
// the only requirement is knowing which device is asking. Without the identity a take would
// come back as a hold the lease line cannot recognize as this device's own.
//
// There is no release. The control is drawn only while this device does not hold the shell,
// and the next device to take it displaces the holder. The daemon refuses a take against a
// run's hold, so none is offered while a run holds the shell.

import type { TerminalLeaseHolder } from "./state.js";
import type { TerminalDeviceIdentity } from "./hooks/useTerminalDeviceIdentity.js";

/** Which control the lease line offers. */
export type TakeShellAvailability = { readonly control: "acquire" } | { readonly control: "none" };

/**
 * Resolve the one control the lease line allows, from the holder and the identity read.
 *
 * With no identity read there is no control and no sentence about one.
 */
export function resolveTakeShellAvailability(input: {
  readonly holder: TerminalLeaseHolder;
  readonly deviceIdentity: TerminalDeviceIdentity;
}): TakeShellAvailability {
  if (
    input.holder === "held-by-this-device" ||
    input.holder === "held-by-run" ||
    input.deviceIdentity.status !== "read"
  ) {
    return { control: "none" };
  }
  return { control: "acquire" };
}
