// The bind act: the pre-bind read, the bind, and the store it is bound against.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceExecutionModeCapabilitiesReadResponse,
} from "@ai-sidekicks/contracts/workspace";

import { ManualClock } from "@renderer/lib/clock.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { RepoOperations } from "../../repo-operations.js";
import { bridgeOnClock } from "@test/helpers/fixture/bridge.js";
import { bridgeWrapper } from "@test/helpers/app/frame-fixtures.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { settlePrerequisiteRead } from "../repo-mounts.test-support.js";
import { BindWorkspaceController } from "./bind-controller.js";
import { useBindController, type BindBinding } from "./hooks/useBindController.js";

const SESSION_ID = "session-repos";
const OPEN_MOUNT_ID = "mount-open";

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
        state: "preparing",
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

describe("BindWorkspaceController — the pre-bind read", () => {
  it("asks nothing until a user opens the dialog", async () => {
    // A session with six mounts must not put six pre-bind reads on the wire.
    const { controller, clock } = open(OPEN_MOUNT_ID);
    controller.requestRead("reconnect");
    await settlePrerequisiteRead(controller, clock);
    expect(controller.snapshot.prerequisite.status).toBe("not-read");
  });

  it("reads what THIS MOUNT admits once the dialog opens", async () => {
    const { controller, clock } = open(OPEN_MOUNT_ID);
    controller.requestCapabilities();
    await settlePrerequisiteRead(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value.availableModes).toStrictEqual([
      "bound-root",
      "provisioned-worktree",
    ]);
  });
});

describe("BindWorkspaceController — the bind itself", () => {
  it("binds into this session and publishes the mode and state the daemon answered", async () => {
    // The mount belongs to the machine, so the session says whose workspace this is.
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
    expect(settlement.status === "bound" && settlement.response.state).toBe("preparing");
  });

  it("refuses to put a second bind on the wire for one intent", async () => {
    const { controller } = open(OPEN_MOUNT_ID);
    const first = controller.bind("bound-root", undefined);
    // The single-flight key is taken, so the second call never reaches the wire.
    await controller.bind("provisioned-worktree", undefined);
    await first;
    const { act: settlement } = controller.snapshot;
    expect(settlement.status === "bound" && settlement.response.executionMode).toBe("bound-root");
  });
});

describe("useBindController — the store is the axis the resource key cannot carry", () => {
  async function bindOnce(bind: BindBinding["bind"]): Promise<void> {
    await act(async () => {
      bind("bound-root", undefined);
      await crossMacrotaskBoundary();
    });
  }

  it("mints a fresh controller when the store is rebuilt under an unchanged bridge", async () => {
    // The seam holds one controller per (bridge, mount id), and a store rebuilt across a
    // reconnect keeps that address, so the controller stayed armed on a store nothing reads.
    const { bridge, clock } = bridgeOnClock("repos");
    const operations = scriptedDaemon();
    const rendered = renderHook(
      ({ sessionStore }) => useBindController(bridge, OPEN_MOUNT_ID, sessionStore, operations),
      {
        initialProps: { sessionStore: new SessionStore({ sessionId: SESSION_ID }) },
        wrapper: bridgeWrapper(bridge, clock),
      },
    );
    await bindOnce(rendered.result.current.bind);
    expect(rendered.result.current.reading.act.status).toBe("bound");

    rendered.rerender({ sessionStore: new SessionStore({ sessionId: SESSION_ID }) });

    // A fresh controller has sent nothing; the retired one still held its settlement.
    expect(rendered.result.current.reading.act.status).toBe("idle");
  });

  it("disposes the controller the swap replaced, once, and keeps the new one live", async () => {
    // A replaced controller left alive would keep listening to a store nothing draws from;
    // disposing the new one instead could not publish the bind below.
    const disposals = vi.spyOn(BindWorkspaceController.prototype, "dispose");
    try {
      const { bridge, clock } = bridgeOnClock("repos");
      const operations = scriptedDaemon();
      const rendered = renderHook(
        ({ sessionStore }) => useBindController(bridge, OPEN_MOUNT_ID, sessionStore, operations),
        {
          initialProps: { sessionStore: new SessionStore({ sessionId: SESSION_ID }) },
          wrapper: bridgeWrapper(bridge, clock),
        },
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
});
