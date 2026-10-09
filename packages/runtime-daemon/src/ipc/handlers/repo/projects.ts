// The project verbs: `repo.projectList`, the live list of every project, sent whole on subscribe
// and on each change, and the edits on one project's own row, each answering the project as the
// list now draws it. The edits are `mutating`, so the gate refuses them on a connection whose
// `daemon.hello` was incompatible; the list is not.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { ProjectList } from "@ai-sidekicks/contracts/project";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import type { ProjectListFeed } from "../../../workspace/project/list-feed.js";
import type { ProjectService } from "../../../workspace/project/service.js";
import { openLatestValueStream, type LatestValueStreamDeps } from "../../latest-value-stream.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";

/** What the project verbs call. */
export interface RepoProjectMethodsDeps extends LatestValueStreamDeps {
  /** The daemon's one live projects list. */
  readonly listFeed: Pick<ProjectListFeed, "open">;
  readonly projects: Pick<
    ProjectService,
    | "rename"
    | "archive"
    | "reactivate"
    | "updateSetup"
    | "updateEnvironment"
    | "updateBranchPattern"
  >;
}

/**
 * Binds the live projects list and the six project edits onto the registry. A list that cannot be
 * read rejects the subscribe with nothing left open; one that later fails ends the subscription.
 */
export function registerRepoProjectMethods(
  registry: MethodRegistry,
  deps: RepoProjectMethodsDeps,
): void {
  const list = REPO_METHOD_DESCRIPTORS["repo.projectList"];
  registerDescribedSubscription(registry, list, (_request, context) =>
    openLatestValueStream<ProjectList>(deps, {
      method: list.method,
      emissionSchema: list.emissionSchema,
      transportId: context.transportId,
      follow: (outlet) => {
        const opening = deps.listFeed.open({
          onList: (projects) => {
            outlet.send({ projects });
          },
          onFailure: outlet.fail,
        });
        outlet.send({ projects: opening.projects });
        return opening.detach;
      },
    }),
  );

  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.projectRename"],
    async (request) => ({ project: await deps.projects.rename(request.projectId, request.name) }),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.projectArchive"],
    async (request) => ({ project: await deps.projects.archive(request.projectId) }),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.projectReactivate"],
    async (request) => ({ project: await deps.projects.reactivate(request.projectId) }),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.projectSetupUpdate"],
    async (request) => ({
      project: await deps.projects.updateSetup(request.projectId, request.setup),
    }),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.projectEnvironmentUpdate"],
    async (request) => ({
      project: await deps.projects.updateEnvironment(request.projectId, request.environmentRows),
    }),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.projectBranchPatternUpdate"],
    async (request) => ({
      project: await deps.projects.updateBranchPattern(request.projectId, request.pattern),
    }),
  );
}
