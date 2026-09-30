// Preparing an execution root: the check first, then the act, over scripted calls.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { DIRTY_BRANCH, preparingDaemon } from "../repo-mounts.test-support.js";
import { ExecutionRootPrepareController } from "./prepare-controller.js";

const controllers: ExecutionRootPrepareController[] = [];

function open(): {
  readonly controller: ExecutionRootPrepareController;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new ExecutionRootPrepareController({
    operations: scriptedRepoOperations(preparingDaemon()),
    subject: {
      workspaceId: "workspace-sidekicks",
      repoMountId: "mount-sidekicks",
      executionMode: "provisioned-worktree",
    },
    sessionStore: new SessionStore({ sessionId: "session-repos" }),
    clock,
  });
  controllers.push(controller);
  return { controller, clock };
}

async function settleCheck(
  controller: ExecutionRootPrepareController,
  clock: ManualClock,
): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (
    let turn = 0;
    turn < 50 && controller.snapshot.prerequisite.status === "reading";
    turn += 1
  ) {
    await Promise.resolve();
  }
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
    await settleCheck(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value.kind).toBe("dirty");
  });

  it("withdraws the question when the field is cleared", async () => {
    const { controller, clock } = open();
    controller.checkReuse(DIRTY_BRANCH);
    await settleCheck(controller, clock);
    controller.checkReuse("   ");
    // A verdict left on screen would be attached to a branch nobody named.
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });
});

describe("ExecutionRootPrepareController — the prepare", () => {
  it("publishes the root the daemon put on disk, settled the only way a prepare settles", async () => {
    // `ready`, not `preparing`: the execution-root service awaits the reprovision completion
    // before answering, so "prepared / provisioning" is a pair no daemon can send.
    const { controller, clock } = open();
    controller.checkReuse("feat/fresh-root");
    await settleCheck(controller, clock);
    await controller.prepare("feat/fresh-root", false);
    const { act } = controller.snapshot;
    expect(act.status).toBe("prepared");
    expect(act.status === "prepared" && act.executionRoot.length).toBeGreaterThan(0);
    expect(act.status === "prepared" && act.state).toBe("ready");
  });
});
