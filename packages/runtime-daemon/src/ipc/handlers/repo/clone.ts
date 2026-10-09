// The clone verbs: `repo.cloneFolderRead` (where a clone goes), `repo.clone`, the live clone card
// `repo.cloneSubscribe`, `repo.cloneAnswer` (a sign-in git asked for), `repo.cloneCancel` and
// `repo.largeFilesPull`. Each waits for the clone service, which starts once git's question
// program is listening, and answers `repo.clone_unavailable` when it could not start or, on a
// platform with no launcher for that program, was never started. The mutations are `mutating`,
// so the gate refuses them on a connection whose `daemon.hello` was incompatible; the reads are
// not.

import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { RepoCloneStatus } from "@ai-sidekicks/contracts/repo/clone";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";

import { describeRejection } from "../../../rejection.js";
import type { CloneService } from "../../../workspace/clone/service.js";
import { RepoCloneUnavailableError } from "../../../workspace/repo/errors.js";
import { openLatestValueStream, type LatestValueStreamDeps } from "../../latest-value-stream.js";
import {
  registerDescribedMethod,
  registerDescribedSubscription,
} from "../register-described-method.js";

// The clone service's calls the verbs make.
type CloneVerbCalls = Pick<
  CloneService,
  "readCloneFolder" | "clone" | "subscribe" | "answer" | "cancel" | "pullLargeFiles"
>;

/** What the clone verbs call. */
export interface RepoCloneMethodsDeps extends LatestValueStreamDeps {
  /**
   * Resolves with the clone service once it has started, or with `null` when it is never started,
   * and rejects with the failure when it could not start.
   */
  readonly clones: Promise<CloneVerbCalls | null>;
}

/**
 * Binds the six clone verbs onto the registry. The clone card is sent whole on subscribe and on
 * each update; an unknown project rejects the subscribe with nothing left open.
 */
export function registerRepoCloneMethods(
  registry: MethodRegistry,
  deps: RepoCloneMethodsDeps,
): void {
  // The service once started. A start that failed answers the typed error with the failure's own
  // text; one never made answers it with no message.
  const readClones = async (): Promise<CloneVerbCalls> => {
    let clones: CloneVerbCalls | null;
    try {
      clones = await deps.clones;
    } catch (error) {
      throw new RepoCloneUnavailableError(describeRejection(error));
    }
    if (clones === null) throw new RepoCloneUnavailableError("");
    return clones;
  };
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.cloneFolderRead"], async () =>
    (await readClones()).readCloneFolder(),
  );
  registerDescribedMethod(registry, REPO_METHOD_DESCRIPTORS["repo.clone"], async (request) =>
    (await readClones()).clone(request),
  );

  const card = REPO_METHOD_DESCRIPTORS["repo.cloneSubscribe"];
  registerDescribedSubscription(registry, card, (request, context) =>
    openLatestValueStream<RepoCloneStatus>(deps, {
      method: card.method,
      emissionSchema: card.emissionSchema,
      transportId: context.transportId,
      follow: async (outlet) => {
        const clones = await readClones();
        const opened = await clones.subscribe(request.projectId, outlet.send);
        outlet.send(opened.status);
        return opened.detach;
      },
    }),
  );

  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.cloneAnswer"],
    async (request) => {
      (await readClones()).answer(request.projectId, request.questionId, request.answer);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.cloneCancel"],
    async (request) => {
      await (await readClones()).cancel(request.projectId);
      return {};
    },
  );
  registerDescribedMethod(
    registry,
    REPO_METHOD_DESCRIPTORS["repo.largeFilesPull"],
    async (request) => {
      await (await readClones()).pullLargeFiles(request.projectId);
      return {};
    },
  );
}
