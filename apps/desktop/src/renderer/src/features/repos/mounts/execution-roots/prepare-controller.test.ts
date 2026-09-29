// Preparing an execution root: the check first, then the act, over scripted calls.
//
// The order is the subject. Without the reuse check the form could not ask for the
// consent the dirty case needs, so every case below is about what the check tells the form.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { DIRTY_BRANCH, INCOMPATIBLE_BRANCH, preparingDaemon } from "../repo-mounts.test-support.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
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

/** Move past the debounce and let the check land. */
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

  it("finds the incompatible candidate, which admits no consent", async () => {
    const { controller, clock } = open();
    controller.checkReuse(INCOMPATIBLE_BRANCH);
    await settleCheck(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value.kind).toBe("incompatible");
  });

  it("answers an unheld branch with no candidate at all", async () => {
    const { controller, clock } = open();
    controller.checkReuse("feat/nothing-here");
    await settleCheck(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value.kind).toBe("none");
  });

  it("withdraws the question when the field is cleared", async () => {
    const { controller, clock } = open();
    controller.checkReuse(DIRTY_BRANCH);
    await settleCheck(controller, clock);
    controller.checkReuse("   ");
    // A verdict left on screen would be attached to a branch nobody named.
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("negative control: a refresh reason with no branch named puts nothing on the wire", async () => {
    // A window focus over a form nobody has typed into has no question to re-ask.
    const { controller, clock } = open();
    controller.start();
    controller.requestRead("window-focus");
    await settleCheck(controller, clock);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("declares the repos feature's event census, so a retired root re-asks the question", () => {
    // A worktree appearing or being retired is exactly what makes a verdict wrong, and
    // the census is the repos feature's own rather than a list written in this module.
    const { controller } = open();
    expect([...controller.triggeringEventKinds].sort()).toStrictEqual(
      [...REPO_LIFECYCLE_EVENT_KINDS].sort(),
    );
  });
});

describe("ExecutionRootPrepareController — the prepare", () => {
  it("publishes the root the daemon put on disk, settled the only way a prepare settles", async () => {
    // `ready` AND NOT `preparing`, which is a claim about the producer rather than
    // about the fixture: the execution-root service awaits the reprovision completion
    // before it answers and every path that does not reach it throws, so a settlement
    // this form renders as "prepared / provisioning" is a pair no daemon can send.
    const { controller, clock } = open();
    controller.checkReuse("feat/fresh-root");
    await settleCheck(controller, clock);
    await controller.prepare("feat/fresh-root", false);
    const { act } = controller.snapshot;
    expect(act.status).toBe("prepared");
    expect(act.status === "prepared" && act.executionRoot.length).toBeGreaterThan(0);
    expect(act.status === "prepared" && act.state).toBe("ready");
  });

  it("clears the act without clearing the verdict beside it", async () => {
    const { controller, clock } = open();
    controller.checkReuse(DIRTY_BRANCH);
    await settleCheck(controller, clock);
    await controller.prepare(DIRTY_BRANCH, false);
    controller.clearAct();
    expect(controller.snapshot.act.status).toBe("idle");
    expect(controller.snapshot.prerequisite.status).toBe("read");
  });
});
