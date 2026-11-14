// A mount's changed health, decoded at the bridge, so the lost-folder banner reads how the folder
// is lost from what this returns and never from the check.

import {
  validateRepoMountHealthChangedPayload,
  type RepoMountHealthChangedPayload,
} from "@ai-sidekicks/contracts/repo/mount";

/** Read a `repoMount.health.changed` payload, or `undefined` where the wire's is off contract. */
export function readRepoMountHealthChangedPayload(
  payload: unknown,
): RepoMountHealthChangedPayload | undefined {
  return validateRepoMountHealthChangedPayload(payload) ? payload : undefined;
}
