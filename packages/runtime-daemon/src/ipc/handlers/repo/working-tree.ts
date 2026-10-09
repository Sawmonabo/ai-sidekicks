// `repo.workingTreeSubscribe`: a mark each time the folder a session works in changes, so the
// changes pane reads it again. The stream follows the session when it moves to another folder.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { WorkingTreeChange } from "@ai-sidekicks/contracts/repo/git-reads";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import type { WorkingFolderWatcher } from "../../../git/worktree/watch.js";
import { openLatestValueStream, type LatestValueStreamDeps } from "../../latest-value-stream.js";
import { registerDescribedSubscription } from "../register-described-method.js";

/** What `repo.workingTreeSubscribe`'s handler calls. */
export interface RepoWorkingTreeMethodsDeps extends LatestValueStreamDeps {
  readonly watcher: Pick<WorkingFolderWatcher, "subscribe">;
}

/**
 * Binds `repo.workingTreeSubscribe` onto the registry. A session this daemon holds no row for
 * rejects the subscribe with nothing left open.
 */
export function registerRepoWorkingTreeMethods(
  registry: MethodRegistry,
  deps: RepoWorkingTreeMethodsDeps,
): void {
  const changes = REPO_METHOD_DESCRIPTORS["repo.workingTreeSubscribe"];
  registerDescribedSubscription(registry, changes, (request, context) =>
    openLatestValueStream<WorkingTreeChange>(deps, {
      method: changes.method,
      emissionSchema: changes.emissionSchema,
      transportId: context.transportId,
      follow: (outlet) => deps.watcher.subscribe(request.sessionId, outlet.send),
    }),
  );
}
