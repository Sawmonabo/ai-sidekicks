// The bind act: the pre-bind read and both settled arms.
//
// Driven through the real controller over scripted calls that answer the way the daemon
// does for a git mount and for a plain directory.

import { afterEach, describe, expect, it } from "vitest";

import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";

import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import type { RepoOperations } from "../../repo-operations.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { BindWorkspaceController } from "./bind-controller.js";

const SESSION_ID = "session-repos";
const GIT_MOUNT_ID = "mount-git";
const PLAIN_MOUNT_ID = "mount-plain";

/** A git mount admits every mode; a plain directory admits reading and says why not more. */
const GIT_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only", "branch", "worktree", "ephemeral clone"],
  defaultMode: "worktree",
};
const PLAIN_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["read-only"],
  defaultMode: "read-only",
  restrictions: { worktree: "this directory is not a git repository" },
};

/** The daemon's answers: a read-only bind carries its root, a writable one is provisioning. */
function scriptedDaemon(): Pick<RepoOperations, "bindWorkspace" | "readMountExecutionModes"> {
  return {
    readMountExecutionModes: (repoMountId) =>
      Promise.resolve(repoMountId === GIT_MOUNT_ID ? GIT_CAPABILITIES : PLAIN_CAPABILITIES),
    bindWorkspace: (request: WorkspaceBindRequest) => {
      const readOnly = request.executionMode === "read-only";
      return Promise.resolve({
        workspaceId: "workspace-new",
        executionMode: request.executionMode,
        state: readOnly ? "ready" : "provisioning",
        ...(readOnly ? { fsRoot: "/Users/dev/code/ai-sidekicks" } : {}),
      } as unknown as WorkspaceBindResponse);
    },
  };
}

const controllers: BindWorkspaceController[] = [];

function open(repoMountId: string): {
  readonly controller: BindWorkspaceController;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new BindWorkspaceController({
    operations: scriptedRepoOperations(scriptedDaemon()),
    repoMountId,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
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
  for (let turn = 0; turn < 50 && controller.snapshot.prerequisite.status !== "read"; turn += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("BindWorkspaceController — the pre-bind read", () => {
  it("asks nothing until a user opens the dialog", async () => {
    // A session with six mounts must not put six pre-bind reads on the wire for a
    // person who is not binding anything.
    const { controller, clock } = open(GIT_MOUNT_ID);
    controller.requestRead("reconnect");
    await settleCapabilities(controller, clock);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("reads what THIS MOUNT admits once the dialog opens", async () => {
    const { controller, clock } = open(GIT_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value.availableModes).toStrictEqual([
      "read-only",
      "branch",
      "worktree",
      "ephemeral clone",
    ]);
  });

  it("carries the mount's own restriction reasons on a plain directory", async () => {
    const { controller, clock } = open(PLAIN_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value.availableModes).toStrictEqual([
      "read-only",
    ]);
    expect(
      prerequisite.status === "read" && prerequisite.value.restrictions?.["worktree"],
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

  it("refuses to put a second bind on the wire for one intent", async () => {
    const { controller } = open(GIT_MOUNT_ID);
    const first = controller.bind("read-only", undefined);
    // The single-flight key is already taken, so the second call returns without
    // reaching the wire, where it would have bound a second workspace.
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
    expect(controller.snapshot.prerequisite.status).toBe("read");
  });

  it("negative control: a disposed controller publishes nothing more", async () => {
    const { controller } = open(GIT_MOUNT_ID);
    const inFlight = controller.bind("read-only", undefined);
    controller.dispose();
    await inFlight;
    expect(controller.snapshot.act.status).toBe("sending");
  });
});
