// How a client finds this machine's daemon run folder, picked once per system: macOS and Linux
// resolve the folder holding the daemon's socket, and Windows, which has none, refuses.

import {
  refuseWindowsDaemonRunFolder,
  resolveDaemonRunFolder,
  type DaemonRunFolder,
  type DaemonRunFolderFacts,
} from "@ai-sidekicks/contracts/daemon/run-folder";

/** Finds the run folder from the facts a client reads off its own process. */
export type DaemonRunFolderResolver = (facts: DaemonRunFolderFacts) => DaemonRunFolder;

const RUN_FOLDER_RESOLVERS: Readonly<Record<string, DaemonRunFolderResolver>> = {
  darwin: resolveDaemonRunFolder,
  linux: resolveDaemonRunFolder,
  win32: refuseWindowsDaemonRunFolder,
};

/**
 * The run folder resolver of `platform`, in Node's spelling. Throws a `RangeError` for a platform
 * the daemon does not run on.
 */
export function selectDaemonRunFolderResolver(platform: string): DaemonRunFolderResolver {
  const resolver = RUN_FOLDER_RESOLVERS[platform];
  if (resolver === undefined) {
    throw new RangeError(`The daemon does not run on the ${platform} platform`);
  }
  return resolver;
}
