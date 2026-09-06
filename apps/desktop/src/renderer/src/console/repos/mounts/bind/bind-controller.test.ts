// The bind act against the fixture: the pre-bind read, both settled arms, and the
// refusal a plain directory earns.
//
// DRIVEN THROUGH THE REAL CONTROLLER AND THE REAL FIXTURE BRIDGE, on
// `attach/attach-controller.test.ts`'s reason: the scripted arms in
// `bridge/scenarios/repos-mutation-replies.ts` are what a person meets on the fixture,
// so a case that stubbed the port would assert against a bridge no window builds.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import { REPOS_SCENARIO } from "../../../bridge/scenarios/repos.js";
import { GIT_MOUNT_ID, PLAIN_MOUNT_ID } from "../../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import { BindWorkspaceController } from "./bind-controller.js";

const controllers: BindWorkspaceController[] = [];

function open(repoMountId: string): {
  readonly controller: BindWorkspaceController;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new BindWorkspaceController({
    bridge: createFixtureBridge({ scenario: REPOS_SCENARIO }),
    repoMountId,
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
    clock,
  });
  controllers.push(controller);
  return { controller, clock };
}

/** Move past the debounce and let the read's promises land. */
async function settleCapabilities(
  controller: BindWorkspaceController,
  clock: ManualClock,
): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (let turn = 0; turn < 50 && controller.snapshot.capabilities.status !== "read"; turn += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("BindWorkspaceController — the pre-bind read", () => {
  it("asks nothing until a participant opens the dialog", async () => {
    // A session with six mounts must not put six pre-bind reads on the wire for a
    // person who is not binding anything.
    const { controller, clock } = open(GIT_MOUNT_ID);
    controller.requestRead("reconnect");
    await settleCapabilities(controller, clock);
    expect(controller.snapshot.capabilities.status).toBe("not-read");
  });

  it("reads what THIS MOUNT admits once the dialog opens", async () => {
    const { controller, clock } = open(GIT_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    const { capabilities } = controller.snapshot;
    expect(capabilities.status).toBe("read");
    expect(
      capabilities.status === "read" && capabilities.capabilities.availableModes,
    ).toStrictEqual(["read-only", "branch", "worktree", "ephemeral clone"]);
  });

  it("carries the mount's own restriction reasons on a plain directory", async () => {
    const { controller, clock } = open(PLAIN_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    const { capabilities } = controller.snapshot;
    expect(
      capabilities.status === "read" && capabilities.capabilities.availableModes,
    ).toStrictEqual(["read-only"]);
    expect(
      capabilities.status === "read" && capabilities.capabilities.restrictions?.["worktree"],
    ).toContain("not a git repository");
  });

  it("declares this family's own event census", () => {
    // What a mount admits changes when the mount does, and two readers of one answer
    // must not disagree about when it goes stale.
    const { controller } = open(GIT_MOUNT_ID);
    expect(controller.triggeringEventKinds.has("repo.attached")).toBe(true);
    expect(controller.triggeringEventKinds.has("workspace.ready")).toBe(true);
    // Negative control: a frame about something else must not re-ask this question.
    expect(controller.triggeringEventKinds.has("run.started")).toBe(false);
  });
});

describe("BindWorkspaceController — the bind itself", () => {
  it("publishes the read-only arm with its root on the same reply", async () => {
    const { controller } = open(GIT_MOUNT_ID);
    await controller.bind("read-only", undefined);
    const { act } = controller.snapshot;
    expect(act.status).toBe("bound");
    expect(act.status === "bound" && act.response.fsRoot).toBeDefined();
    expect(act.status === "bound" && act.response.state).toBe("ready");
  });

  it("publishes the writable arm as a settlement, root and all not yet existing", async () => {
    // `provisioning` with no `fsRoot` is a bind that WORKED. A surface reading the
    // absence as an error would report it as one.
    const { controller } = open(GIT_MOUNT_ID);
    await controller.bind("worktree", undefined);
    const { act } = controller.snapshot;
    expect(act.status).toBe("bound");
    expect(act.status === "bound" && act.response.state).toBe("provisioning");
    expect(act.status === "bound" && act.response.fsRoot).toBeUndefined();
  });

  it("publishes the daemon's refusal rather than swallowing it", async () => {
    const { controller } = open(PLAIN_MOUNT_ID);
    await controller.bind("worktree", undefined);
    const { act } = controller.snapshot;
    expect(act.status).toBe("refused");
    expect(act.status === "refused" && act.refusal.code).toBe("workspace.mode_unsupported");
  });

  it("refuses to put a second bind on the wire for one intent", async () => {
    const { controller } = open(GIT_MOUNT_ID);
    const first = controller.bind("read-only", undefined);
    // The guard reads the published `sending` arm, so the second call returns without
    // reaching the wire — where it would have bound a second workspace.
    await controller.bind("worktree", undefined);
    await first;
    const { act } = controller.snapshot;
    expect(act.status === "bound" && act.response.executionMode).toBe("read-only");
  });

  it("clears the settlement without touching the pre-bind read", async () => {
    const { controller, clock } = open(GIT_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    await controller.bind("read-only", undefined);
    controller.clearAct();
    expect(controller.snapshot.act.status).toBe("idle");
    // Reopening the dialog must not re-read an answer that has not changed.
    expect(controller.snapshot.capabilities.status).toBe("read");
  });

  it("negative control: a disposed controller publishes nothing more", async () => {
    const { controller } = open(GIT_MOUNT_ID);
    const inFlight = controller.bind("read-only", undefined);
    controller.dispose();
    await inFlight;
    expect(controller.snapshot.act.status).toBe("sending");
  });
});
