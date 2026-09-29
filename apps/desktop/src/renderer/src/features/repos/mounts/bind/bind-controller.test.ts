// The bind act: the pre-bind read, the bind, and the store it is bound against.
//
// Driven through the real controller over scripted calls that answer the way the daemon
// does, recording what each bind was asked so a case can say exactly what went out.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { bridgeOnClock, scriptedRepoOperations } from "../../repo-operations.test-support.js";
import {
  BindWorkspaceController,
  useBindController,
  type BindBinding,
} from "@renderer/console/repos/mounts/bind/bind-controller.js";

const SESSION_ID = "session-repos";
const OPEN_MOUNT_ID = "mount-open";
const RESTRICTED_MOUNT_ID = "mount-restricted";

/** One mount admits both modes; the other admits its own root and says why not more. */
const OPEN_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root", "provisioned-worktree"],
  defaultMode: "provisioned-worktree",
};
const RESTRICTED_CAPABILITIES: WorkspaceExecutionModeCapabilitiesReadResponse = {
  availableModes: ["bound-root"],
  defaultMode: "bound-root",
  restrictions: { "provisioned-worktree": "this workspace runs only in its own root" },
};

/** The daemon's answers, and every bind request it was sent. */
function scriptedDaemon(
  bindRequests: WorkspaceBindRequest[] = [],
): Pick<RepoOperations, "bindWorkspace" | "readMountExecutionModes"> {
  return {
    readMountExecutionModes: (repoMountId) =>
      Promise.resolve(repoMountId === OPEN_MOUNT_ID ? OPEN_CAPABILITIES : RESTRICTED_CAPABILITIES),
    bindWorkspace: (request: WorkspaceBindRequest) => {
      bindRequests.push(request);
      return Promise.resolve({
        workspaceId: "workspace-new",
        executionMode: request.executionMode,
        state: "provisioning",
      } as unknown as WorkspaceBindResponse);
    },
  };
}

const controllers: BindWorkspaceController[] = [];

function open(
  repoMountId: string,
  bindRequests: WorkspaceBindRequest[] = [],
): {
  readonly controller: BindWorkspaceController;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new BindWorkspaceController({
    operations: scriptedRepoOperations(scriptedDaemon(bindRequests)),
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
    const { controller, clock } = open(OPEN_MOUNT_ID);
    controller.requestRead("reconnect");
    await settleCapabilities(controller, clock);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("reads what THIS MOUNT admits once the dialog opens", async () => {
    const { controller, clock } = open(OPEN_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value.availableModes).toStrictEqual([
      "bound-root",
      "provisioned-worktree",
    ]);
  });

  it("carries the mount's own restriction reasons", async () => {
    const { controller, clock } = open(RESTRICTED_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value.availableModes).toStrictEqual([
      "bound-root",
    ]);
    expect(
      prerequisite.status === "read" && prerequisite.value.restrictions?.["provisioned-worktree"],
    ).toContain("its own root");
  });

  it("declares this family's own event census", () => {
    // What a mount admits changes when the mount does, and two readers of one answer
    // must not disagree about when it goes stale.
    const { controller } = open(OPEN_MOUNT_ID);
    expect(controller.triggeringEventKinds.has("workspace.ready")).toBe(true);
    // Negative control: a frame about something else must not re-ask this question.
    expect(controller.triggeringEventKinds.has("run.started")).toBe(false);
  });
});

describe("BindWorkspaceController — the bind itself", () => {
  it("binds into this session and publishes the mode and state the daemon answered", async () => {
    // The mount belongs to the machine, so the session is what says whose workspace
    // this is; a bind without it would be refused by the contract.
    const bindRequests: WorkspaceBindRequest[] = [];
    const { controller } = open(OPEN_MOUNT_ID, bindRequests);
    await controller.bind("provisioned-worktree", undefined);
    expect(bindRequests).toStrictEqual([
      {
        sessionId: SESSION_ID,
        repoMountId: OPEN_MOUNT_ID,
        executionMode: "provisioned-worktree",
      },
    ]);
    const { act: settlement } = controller.snapshot;
    expect(settlement.status).toBe("bound");
    expect(settlement.status === "bound" && settlement.response.state).toBe("provisioning");
  });

  it("refuses to put a second bind on the wire for one intent", async () => {
    const { controller } = open(OPEN_MOUNT_ID);
    const first = controller.bind("bound-root", undefined);
    // The single-flight key is already taken, so the second call returns without
    // reaching the wire, where it would have bound a second workspace.
    await controller.bind("provisioned-worktree", undefined);
    await first;
    const { act: settlement } = controller.snapshot;
    expect(settlement.status === "bound" && settlement.response.executionMode).toBe("bound-root");
  });

  it("clears the settlement without touching the pre-bind read", async () => {
    const { controller, clock } = open(OPEN_MOUNT_ID);
    controller.requestCapabilities();
    await settleCapabilities(controller, clock);
    await controller.bind("bound-root", undefined);
    controller.clearAct();
    expect(controller.snapshot.act.status).toBe("idle");
    // Reopening the dialog must not re-read an answer that has not changed.
    expect(controller.snapshot.prerequisite.status).toBe("read");
  });

  it("negative control: a disposed controller publishes nothing more", async () => {
    const { controller } = open(OPEN_MOUNT_ID);
    const inFlight = controller.bind("bound-root", undefined);
    controller.dispose();
    await inFlight;
    expect(controller.snapshot.act.status).toBe("sending");
  });
});

describe("useBindController — the store is the axis the resource key cannot carry", () => {
  /** Bind once through the hook, and let the settlement land. */
  async function bindOnce(bind: BindBinding["bind"]): Promise<void> {
    await act(async () => {
      bind("bound-root", undefined);
      await crossMacrotaskBoundary();
    });
  }

  it("mints a fresh controller when the store is rebuilt under an unchanged bridge", async () => {
    // The defect: the seam holds one controller per `(bridge, mount id)`, and a projection
    // rebuilt across a reconnect carries that whole address — so the controller stayed,
    // armed on a store nothing else reads.
    const bridge = bridgeOnClock();
    const operations = scriptedDaemon();
    const rendered = renderHook(
      ({ sessionStore }) => useBindController(bridge, OPEN_MOUNT_ID, sessionStore, operations),
      { initialProps: { sessionStore: new SessionStore({ sessionId: SESSION_ID }) } },
    );
    await bindOnce(rendered.result.current.bind);
    expect(rendered.result.current.reading.act.status).toBe("bound");

    rendered.rerender({ sessionStore: new SessionStore({ sessionId: SESSION_ID }) });

    // A fresh controller has sent nothing, where the retired one still held the
    // settlement it read against the store that is gone.
    expect(rendered.result.current.reading.act.status).toBe("idle");
  });

  it("disposes the controller the swap replaced, once, and keeps the new one live", async () => {
    // A controller replaced but never disposed would go on listening to a store nothing on
    // screen is drawn from; one that disposed the new controller instead could not publish
    // the bind below.
    const disposals = vi.spyOn(BindWorkspaceController.prototype, "dispose");
    try {
      const bridge = bridgeOnClock();
      const operations = scriptedDaemon();
      const rendered = renderHook(
        ({ sessionStore }) => useBindController(bridge, OPEN_MOUNT_ID, sessionStore, operations),
        { initialProps: { sessionStore: new SessionStore({ sessionId: SESSION_ID }) } },
      );
      expect(disposals).not.toHaveBeenCalled();

      rendered.rerender({ sessionStore: new SessionStore({ sessionId: SESSION_ID }) });

      expect(disposals).toHaveBeenCalledTimes(1);

      await bindOnce(rendered.result.current.bind);
      expect(rendered.result.current.reading.act.status).toBe("bound");
    } finally {
      disposals.mockRestore();
    }
  });

  it("negative control: a store standing still rebinds nothing", async () => {
    // Without this the case above would pass against a binding that re-opened a
    // controller on every render, which would lose the settlement on each pass.
    const bridge = bridgeOnClock();
    const operations = scriptedDaemon();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const rendered = renderHook(
      ({ held }) => useBindController(bridge, OPEN_MOUNT_ID, held, operations),
      { initialProps: { held: sessionStore } },
    );
    await bindOnce(rendered.result.current.bind);

    rendered.rerender({ held: sessionStore });
    rendered.rerender({ held: sessionStore });

    expect(rendered.result.current.reading.act.status).toBe("bound");
  });
});
