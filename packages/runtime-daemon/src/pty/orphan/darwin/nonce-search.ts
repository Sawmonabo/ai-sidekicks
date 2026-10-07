// Finds terminal children by the nonce in their environment, for children whose process the daemon
// never recorded and for descendants that left their parent's tree. A child caught before it starts
// its program is still node-pty's helper, whose environment the system shows. macOS hides the
// environment of its own programs, such as `/bin/zsh`, but a shell the helper started dies on the
// hangup its terminal sends when the daemon's end closes it.

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
