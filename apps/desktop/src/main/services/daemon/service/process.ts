// The background service's process as main ends it: through the client's own ending in the addon,
// by the identity the service reported or, for one main started, the identity its process id
// reads now. The ending pins the process first, so an id another process took is never signaled.

import {
  endDaemonProcess,
  readProcessIdentity,
  type DaemonEndingOutcome,
} from "@ai-sidekicks/client-sdk";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

/**
 * End the service process `identity` names, as one whose link died or that never answered: the
 * terminate signal at once, and the kill once the drain bound and its grace have passed. Resolves
 * once the process has ended, with the end that took effect or the error in the wire's shape.
 */
export function endServiceProcess(identity: ProcessIdentity): Promise<DaemonEndingOutcome> {
  return endDaemonProcess(JSON.stringify(identity));
}

/**
 * The identity of the process `processId` names now, or `undefined` when no process holds it.
 * Throws the system's error.
 */
export function readServiceProcessIdentity(processId: number): ProcessIdentity | undefined {
  const identity = readProcessIdentity(processId);
  // The addon writes the contract's own identity.
  return identity === null ? undefined : (JSON.parse(identity) as ProcessIdentity);
}
