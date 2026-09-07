// Preparing an execution root: the check first, then the act, against the fixture.
//
// THE ORDER IS THE SUBJECT. Without the reuse check the surface would learn the same
// three facts as refusals, after the fact, with no way to ask for the consent the dirty
// case needs — so every case below is about what the check tells the form.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { GIT_MOUNT_ID, GIT_WORKSPACE_ID } from "../../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import { ExecutionRootPrepareController } from "./prepare-controller.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";

const controllers: ExecutionRootPrepareController[] = [];

function open(executionMode: "worktree" | "ephemeral clone" = "worktree"): {
  readonly controller: ExecutionRootPrepareController;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new ExecutionRootPrepareController({
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    subject: { workspaceId: GIT_WORKSPACE_ID, repoMountId: GIT_MOUNT_ID, executionMode },
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
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
  it("finds the dirty, compatible candidate the fixture holds", async () => {
    const { controller, clock } = open();
    controller.checkReuse("feat/rate-limit-wiring");
    await settleCheck(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value.kind).toBe("dirty");
  });

  it("finds the incompatible candidate, which admits no consent", async () => {
    const { controller, clock } = open();
    controller.checkReuse("review/rate-limit-wiring");
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
    controller.checkReuse("feat/rate-limit-wiring");
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

  it("declares this family's event census, so a retired root re-asks the question", () => {
    // A worktree appearing or being retired is exactly what makes a verdict wrong, and
    // the census is the family's own rather than a list written in this module.
    const { controller } = open();
    expect([...controller.triggeringEventKinds].sort()).toStrictEqual(
      [...REPO_LIFECYCLE_EVENT_KINDS].sort(),
    );
  });
});

describe("ExecutionRootPrepareController — the prepare", () => {
  it("publishes the root the daemon put on disk", async () => {
    const { controller, clock } = open();
    controller.checkReuse("feat/fresh-root");
    await settleCheck(controller, clock);
    await controller.prepare("feat/fresh-root", false);
    const { act } = controller.snapshot;
    expect(act.status).toBe("prepared");
    expect(act.status === "prepared" && act.executionRoot.length).toBeGreaterThan(0);
  });

  it("publishes the branch-collision refusal rather than swallowing it", async () => {
    const { controller } = open();
    await controller.prepare("feat/rate-limit-wiring", false);
    const { act } = controller.snapshot;
    expect(act.status).toBe("refused");
    expect(act.status === "refused" && act.refusal.code).toBe("worktree.branch_collision");
  });

  it("prepares a clone through the clone call, with no reuse check behind it", async () => {
    const { controller } = open("ephemeral clone");
    await controller.prepareClone("feat/clone-root");
    const { act, prerequisite } = controller.snapshot;
    expect(act.status).toBe("prepared");
    // A clone is minted per run and nothing is reused, so the check is never made.
    expect(prerequisite.status).toBe("not-read");
  });

  it("clears the act without clearing the verdict beside it", async () => {
    const { controller, clock } = open();
    controller.checkReuse("feat/rate-limit-wiring");
    await settleCheck(controller, clock);
    await controller.prepare("feat/rate-limit-wiring", false);
    controller.clearAct();
    expect(controller.snapshot.act.status).toBe("idle");
    expect(controller.snapshot.prerequisite.status).toBe("read");
  });
});
