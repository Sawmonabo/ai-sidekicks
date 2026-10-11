// `session.setWorkingFolder`: moves a session into another tree of its repository, at once when
// none of its runs is live, else when the live run ends. The descriptor is `mutating`, so the gate
// refuses it on a connection whose `daemon.hello` was incompatible.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";

import type { SessionWorkingFolders } from "../../../session/working-folder/move.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What `session.setWorkingFolder`'s handler calls. */
export interface SessionWorkingFolderDeps {
  readonly workingFolders: Pick<SessionWorkingFolders, "set">;
}

/** Binds `session.setWorkingFolder` onto the registry. */
export function registerSessionWorkingFolder(
  registry: MethodRegistry,
  deps: SessionWorkingFolderDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.setWorkingFolder"],
    (request) => deps.workingFolders.set(request),
  );
}
