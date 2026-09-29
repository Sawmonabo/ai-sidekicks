// Whether this device may take the shell.
//
// A FOLD RATHER THAN A CONDITION IN THE LINE, on `lease-model.ts`'s rule: the lease
// line RENDERS, and the moment it acquires a rule that rule belongs somewhere it can
// be driven without mounting React.
//
// THERE IS NO ENTITLEMENT AXIS, and its absence is the design. The shell belongs to the
// one person using this machine, so nothing here asks what they are allowed to do —
// every device that can say which device it is may take the shell. What the fold still
// needs is the IDENTITY, because it is how `held-by-this-device` is told from a hold this device
// does not have: a control offered without it would be one whose outcome the surface
// cannot report, since a take would come back as a hold it could not recognize as its
// own.
//
// THERE IS NO RELEASE. The control is drawn only while this device does not hold the
// shell, and the next device that takes it displaces the holder.

import type { TerminalLeaseHolder } from "./lease-model.js";
import type { TerminalDeviceIdentity } from "./hooks/useTerminalDeviceIdentity.js";

/** Which control the lease line offers. */
export type TakeShellAvailability = { readonly control: "acquire" } | { readonly control: "none" };

/**
 * Resolve the one control this surface allows, from the holding and the identity read.
 *
 * With no identity read there is no control and no sentence about one.
 */
export function resolveTakeShellAvailability(input: {
  readonly holding: TerminalLeaseHolder;
  readonly deviceIdentity: TerminalDeviceIdentity;
}): TakeShellAvailability {
  if (input.holding === "held-by-this-device" || input.deviceIdentity.status !== "read") {
    return { control: "none" };
  }
  return { control: "acquire" };
}
