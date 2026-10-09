// The workspace verbs: `repo.workspaceBind`, which binds a session to an attached mount, and
// `repo.workspaceList`, a session's workspaces through the health projection. The bind is
// `mutating`, so the gate refuses it on a connection whose `daemon.hello` was incompatible.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import type { WorkspaceService } from "../../../workspace/service.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What the workspace verbs call. */
export interface RepoWorkspaceMethodsDeps {
  readonly workspaces: Pick<WorkspaceService, "bind" | "list">;
}

/** Binds `repo.workspaceBind` and `repo.workspaceList` onto the registry. */
export function registerRepoWorkspaceMethods(
  registry: MethodRegistry,
  deps: RepoWorkspaceMethodsDeps,
): void {
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.workspaceBind"], (request) =>
    deps.workspaces.bind(request),
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.workspaceList"], (request) =>
    deps.workspaces.list(request),
  );
}
