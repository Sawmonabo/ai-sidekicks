// Finds a terminal child whose start the daemon recorded but whose process it never did, by the
// nonce in its environment. macOS shows the environment of the person's own programs, such as a
// provider's Node process, but strips it from its own, such as `/bin/zsh`, so a login shell started
// in that moment cannot be found this way.

import { SPAWN_NONCE_ENVIRONMENT_NAME } from "../registry.js";
import type { DarwinSystemLibrary } from "./system-library.js";

/** Lists the processes of the user with `userId` whose environment carries `nonce`. */
export function findDarwinProcessesCarryingNonce(
  library: DarwinSystemLibrary,
  userId: number,
  nonce: string,
): number[] {
  const nonceEntry = `${SPAWN_NONCE_ENVIRONMENT_NAME}=${nonce}`;
  return library
    .listUserProcessIds(userId)
    .filter((processId) => library.readProcessEnvironment(processId)?.includes(nonceEntry));
}
