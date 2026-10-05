// Preparing an execution root: the check first, then the act, over scripted calls.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import { scriptedRepoOperations } from "#renderer/features/repos/repo-operations.test-support.js";
import {
  DIRTY_BRANCH,
  preparingDaemon,
  settlePrerequisiteRead,
} from "../../repo-mounts.test-support.js";
import { ExecutionRootPrepareController, type PrepareOperations } from "./controller.js";

const controllers: ExecutionRootPrepareController[] = [];

function open(operations: PrepareOperations = preparingDaemon()): {
  readonly controller: ExecutionRootPrepareController;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new ExecutionRootPrepareController({
    operations: scriptedRepoOperations(operations),
    subject: {
      workspaceId: "workspace-sidekicks",
      repoMountId: "mount-sidekicks",
      executionMode: "provisioned-worktree",
    },
    sessionStore: new SessionStore({ sessionId: "session-repos" }),
    ownerWindow: window,
    clock,
  });
  controllers.push(controller);
  return { controller, clock };
}

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("ExecutionRootPrepareController — the reuse check", () => {
  it("finds the dirty, compatible candidate the daemon names", async () => {
    const { controller, clock } = open();
    controller.checkReuse(DIRTY_BRANCH);
    await settlePrerequisiteRead(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value.kind).toBe("dirty");
  });

  it("withdraws the question when the field is cleared", async () => {
    const { controller, clock } = open();
    controller.checkReuse(DIRTY_BRANCH);
    await settlePrerequisiteRead(controller, clock);
    controller.checkReuse("   ");
    // A verdict left on screen would be attached to a branch nobody named.
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });
});

describe("ExecutionRootPrepareController — the prepare", () => {
  it("publishes the root the daemon put on disk, settled as every prepare settles", async () => {
    // `ready`, not `preparing`: the execution-root service awaits the preparation's completion
    // before answering, so "prepared / preparing" is a pair no daemon can send.
    const { controller, clock } = open();
    controller.checkReuse("feat/fresh-root");
    await settlePrerequisiteRead(controller, clock);
    await controller.prepare("feat/fresh-root", false);
    const { act } = controller.snapshot;
    expect(act.status).toBe("prepared");
    expect(act.status === "prepared" && act.executionRoot.length).toBeGreaterThan(0);
    expect(act.status === "prepared" && act.state).toBe("ready");
  });
  it("asks about its own mount, naming the checked candidate with the consent given", async () => {
    // A prepare naming another mount's candidate, or none, would reuse or rebuild the wrong
    // worktree; a consent sent without its candidate would consent to nothing.
    const daemon = preparingDaemon();
    const mountsChecked: string[] = [];
    const prepares: Parameters<PrepareOperations["prepareExecutionRoot"]>[0][] = [];
    const { controller, clock } = open({
      checkWorktreeReuse: async (repoMountId, branchName, signal) => {
        mountsChecked.push(repoMountId);
        return await daemon.checkWorktreeReuse(repoMountId, branchName, signal);
      },
      prepareExecutionRoot: async (request) => {
        prepares.push(request);
        return await daemon.prepareExecutionRoot(request);
      },
    });

    controller.checkReuse(DIRTY_BRANCH);
    await settlePrerequisiteRead(controller, clock);
    await controller.prepare(DIRTY_BRANCH, true);
    controller.checkReuse("feat/fresh-root");
    await settlePrerequisiteRead(controller, clock);
    await controller.prepare("feat/fresh-root", true);

    expect(mountsChecked).toStrictEqual(["mount-sidekicks", "mount-sidekicks"]);
    expect(prepares).toStrictEqual([
      {
        workspaceId: "workspace-sidekicks",
        branchName: DIRTY_BRANCH,
        reuseWorktreeId: "worktree-dirty",
        acknowledgeDirtyCandidate: true,
      },
      { workspaceId: "workspace-sidekicks", branchName: "feat/fresh-root" },
    ]);
  });
});
