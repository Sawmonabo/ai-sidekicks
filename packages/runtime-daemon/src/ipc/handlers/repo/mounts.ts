// The folder verbs: `repo.attach` (a folder attached as a project, or the project already holding
// its repository), `repo.mountRead` (one mount with a freshly probed health and what uses it),
// `repo.mountList` (every folder the service can reach), `repo.detach` (a project's `Delete`) and
// `repo.mountReattach` (the lost-folder banner's `Re-attach`). The mutations are `mutating`, so the
// gate refuses them on a connection whose `daemon.hello` was incompatible; the reads are not.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import type { ProjectService } from "../../../workspace/project/service.js";
import type { RepoFolderUsage } from "../../../workspace/folder/usage.js";
import type { RepoMountService } from "../../../workspace/repo/mount-service.js";
import type { RepoMountReattachService } from "../../../workspace/repo/reattach.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What the folder verbs call. */
export interface RepoMountMethodsDeps {
  /** Attaches a folder as a project, and a project's `Delete`. */
  readonly projects: Pick<ProjectService, "attachOrFind" | "detach">;
  /** One mount's row with its health. */
  readonly mounts: Pick<RepoMountService, "read">;
  /** Every reachable folder, and what uses one mount. */
  readonly folderUsage: Pick<RepoFolderUsage, "list" | "readUsage">;
  readonly reattach: Pick<RepoMountReattachService, "reattach">;
}

/** Binds the five folder verbs onto the registry. A second binding on one registry throws. */
export function registerRepoMountMethods(
  registry: MethodRegistry,
  deps: RepoMountMethodsDeps,
): void {
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.attach"], async (request) => {
    const attachment = await deps.projects.attachOrFind(request);
    return {
      repoMountId: attachment.repoMountId,
      state: attachment.state,
      vcsType: attachment.vcsType,
      canonicalRoot: attachment.canonicalRoot,
    };
  });
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.mountRead"], async (request) => {
    const record = await deps.mounts.read(request.repoMountId);
    return { ...record, ...deps.folderUsage.readUsage(request.repoMountId) };
  });
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.mountList"], async () =>
    deps.folderUsage.list(),
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.detach"], (request) =>
    deps.projects.detach(request),
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.mountReattach"], (request) =>
    deps.reattach.reattach(request),
  );
}
