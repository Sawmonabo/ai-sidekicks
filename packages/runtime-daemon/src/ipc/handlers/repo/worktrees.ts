// The worktree verbs: `repo.executionRootPrepare` (a workspace's root made ready, a new worktree
// when it names a branch), `repo.worktreeStatusRead` (a project's worktrees as the list draws
// them), `repo.worktreeRetire`, the kept worktrees (`repo.removedWorktreeList`,
// `repo.worktreeRestore`, `repo.removedWorktreeDelete`), a new tree's setup card
// (`repo.worktreeSetupSubscribe`, `repo.worktreeSetupRetry`) and the copies across volumes a
// removal or a put-back makes (`repo.worktreeCopySubscribe`). The mutations are `mutating`, so the
// gate refuses them on a connection whose `daemon.hello` was incompatible; the reads are not.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";
import type { WorktreeCopyProgress } from "@ai-sidekicks/contracts/worktree/copy-progress";
import type { ExecutionRootPrepareRequest } from "@ai-sidekicks/contracts/worktree/lifecycle";
import type { WorktreeSetupStatus } from "@ai-sidekicks/contracts/worktree/setup";

import type { WorktreeCopiesUnderWay } from "../../../git/worktree/copy-progress.js";
import type { RemovedWorktreeStore } from "../../../git/worktree/removed-store.js";
import type { WorktreeRemoval } from "../../../git/worktree/removal.js";
import type { WorktreeSetupRunner } from "../../../git/worktree/setup.js";
import type { WorktreeStatusReader } from "../../../git/worktree/status.js";
import type {
  ExecutionRootService,
  PrepareExecutionRootInput,
} from "../../../workspace/execution-root-service.js";
import { openLatestValueStream, type LatestValueStreamDeps } from "../../latest-value-stream.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";

/** What the worktree verbs call. */
export interface RepoWorktreeMethodsDeps extends LatestValueStreamDeps {
  readonly executionRoots: Pick<ExecutionRootService, "prepare">;
  readonly status: Pick<WorktreeStatusReader, "read">;
  readonly removal: Pick<WorktreeRemoval, "retire">;
  readonly removedWorktrees: Pick<RemovedWorktreeStore, "list" | "restore" | "delete">;
  readonly setup: Pick<WorktreeSetupRunner, "subscribe" | "retry">;
  readonly copies: Pick<WorktreeCopiesUnderWay, "follow">;
}

/**
 * Binds the worktree verbs onto the registry. The setup card and the copies under way are each
 * sent whole on subscribe and on each update; a setup id with no worktree rejects the subscribe
 * with nothing left open.
 */
export function registerRepoWorktreeMethods(
  registry: MethodRegistry,
  deps: RepoWorktreeMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.executionRootPrepare"],
    async (request) => {
      const prepared = await deps.executionRoots.prepare(prepareInputOf(request));
      return {
        executionRoot: prepared.executionRoot,
        state: prepared.state,
        ...(prepared.worktreeId === undefined ? {} : { worktreeId: prepared.worktreeId }),
        branchContextId: prepared.branchContextId,
      };
    },
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.worktreeStatusRead"], (request) =>
    deps.status.read(request),
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.worktreeRetire"], (request) =>
    deps.removal.retire(request),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.removedWorktreeList"],
    (request) => deps.removedWorktrees.list(request),
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.worktreeRestore"], (request) =>
    deps.removedWorktrees.restore(request.removedWorktreeId),
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.removedWorktreeDelete"],
    async (request) => {
      await deps.removedWorktrees.delete(request.removedWorktreeId);
      return {};
    },
  );

  const card = REPO_METHOD_DESCRIPTORS["repo.worktreeSetupSubscribe"];
  registerDescribedSubscription(registry, card, (request, context) =>
    openLatestValueStream<WorktreeSetupStatus>(deps, {
      method: card.method,
      emissionSchema: card.emissionSchema,
      transportId: context.transportId,
      // The runner hands the listener the card as it stands before returning.
      follow: (outlet) => deps.setup.subscribe(request.worktreeId, outlet.send),
    }),
  );
  // Resolves once the steps it reran have ended; the card stream carries their progress.
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.worktreeSetupRetry"],
    async (request) => {
      await deps.setup.retry(request.worktreeId);
      return {};
    },
  );

  const copies = REPO_METHOD_DESCRIPTORS["repo.worktreeCopySubscribe"];
  registerDescribedSubscription(registry, copies, (request, context) =>
    openLatestValueStream<WorktreeCopyProgress>(deps, {
      method: copies.method,
      emissionSchema: copies.emissionSchema,
      transportId: context.transportId,
      // The copies under way are handed to the listener before `follow` returns.
      follow: (outlet) => deps.copies.follow(request.projectId, outlet.send),
    }),
  );
}

// The wire's optional fields, dropped when absent so the service reads only what was sent.
function prepareInputOf(request: ExecutionRootPrepareRequest): PrepareExecutionRootInput {
  return {
    workspaceId: request.workspaceId,
    ...(request.branchName === undefined ? {} : { branchName: request.branchName }),
    ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
    ...(request.carryUncommitted === undefined
      ? {}
      : { carryUncommitted: request.carryUncommitted }),
  };
}
