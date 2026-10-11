// Finds terminal children by the nonce in their environment, for children whose process the daemon
// never recorded and for descendants that left their parent's tree. A child caught before it starts
// its program is still node-pty's helper, whose environment the system shows. macOS hides the
// start environment of its own restricted programs, such as `/bin/zsh` and `/bin/bash`, from this
// search, so a shell that took its terminal as the daemon died, never recorded, is invisible to
// it; the spawn's daemon-parent check is what keeps such a shell from starting.

import { SPAWN_NONCE_ENVIRONMENT_NAME } from "../registry.js";
import type { DarwinSystemLibrary } from "./system-library.js";

/**
 * Reads the environment of each process the user with `userId` runs, once, and answers which of
 * `nonces` each carries, by process id.
 */
export function findDarwinProcessesCarryingNonces(
  library: DarwinSystemLibrary,
  userId: number,
  nonces: ReadonlySet<string>,
): Map<number, string> {
  const carriers = new Map<number, string>();
  if (nonces.size === 0) {
    return carriers;
  }
  const prefix = `${SPAWN_NONCE_ENVIRONMENT_NAME}=`;
  for (const processId of library.listUserProcessIds(userId)) {
    const nonce = library
      .readProcessEnvironment(processId)
      ?.find((entry) => entry.startsWith(prefix))
      ?.slice(prefix.length);
    if (nonce !== undefined && nonces.has(nonce)) {
      carriers.set(processId, nonce);
    }
  }
  return carriers;
}
