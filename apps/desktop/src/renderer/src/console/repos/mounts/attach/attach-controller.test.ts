// The attach act: the call it makes and what it publishes.
//
// Driven through the real controller over a scripted attach call, which records what it was
// asked so a case can say exactly what went out.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { RepoAttachResponse } from "@ai-sidekicks/contracts";

import { ManualClock } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { bridgeOnClock, scriptedRepoOperations } from "../../repo-operations.test-support.js";
import type { RepoOperations } from "../../repo-operations.js";
import { AttachController, useAttachController } from "./attach-controller.js";

const SESSION_ID = "session-repos";

/** What the daemon answers an attach with. */
const ATTACHED = {
  repoMountId: "mount-new",
  state: "attached",
  vcsType: "git",
  canonicalRoot: "/Users/dev/code/new-repo",
  defaultWorkspaceId: "workspace-new",
} as unknown as RepoAttachResponse;

/** An attach call that answers the minted mount. */
function attachRepository(): Mock<RepoOperations["attachRepository"]> {
  return vi.fn<RepoOperations["attachRepository"]>(() => Promise.resolve(ATTACHED));
}

const controllers: AttachController[] = [];

function open(call: Mock<RepoOperations["attachRepository"]>): AttachController {
  const controller = new AttachController({
    operations: scriptedRepoOperations({ attachRepository: call }),
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    clock: new ManualClock(),
  });
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("AttachController — the attach itself", () => {
  it("sends the path as typed on this session and publishes the minted mount", async () => {
    const call = attachRepository();
    const controller = open(call);

    await controller.attach("/Users/dev/code/new-repo");

    expect(call).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION_ID,
      localPath: "/Users/dev/code/new-repo",
    });
    const { act: settlement } = controller.snapshot;
    expect(settlement.status).toBe("attached");
    expect(settlement.status === "attached" && settlement.response.repoMountId).toBe("mount-new");
  });

  it("refuses to put a second attach on the wire for one intent", async () => {
    const call = attachRepository();
    const controller = open(call);

    const first = controller.attach("/Users/dev/code/new-repo");
    // The single-flight key is already taken, so the second call returns without
    // reaching the wire.
    await controller.attach("/Users/dev/code/other-repo");
    await first;

    expect(call).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.act.status).toBe("attached");
  });

  it("clears the settlement", async () => {
    const controller = open(attachRepository());
    await controller.attach("/Users/dev/code/new-repo");

    controller.clearAct();

    expect(controller.snapshot.act.status).toBe("idle");
  });

  it("negative control: a disposed controller publishes nothing more", async () => {
    const controller = open(attachRepository());
    const inFlight = controller.attach("/Users/dev/code/new-repo");
    controller.dispose();
    await inFlight;
    expect(controller.snapshot.act.status).toBe("sending");
  });
});

describe("useAttachController — the store is the axis the resource key cannot carry", () => {
  /** Attach once through the hook, and let the settlement land. */
  async function attachOnce(attach: (localPath: string) => void): Promise<void> {
    await act(async () => {
      attach("/Users/dev/code/new-repo");
      await crossMacrotaskBoundary();
    });
  }

  it("mints a fresh controller when the store is rebuilt under an unchanged bridge", async () => {
    // The defect: the seam holds one controller per `(bridge, session id)`, and a
    // projection rebuilt across a reconnect carries that whole address — so the
    // controller stayed, armed on a store nothing else reads.
    const bridge = bridgeOnClock();
    const operations = scriptedRepoOperations({ attachRepository: attachRepository() });
    const rendered = renderHook(
      ({ sessionStore }) => useAttachController(bridge, sessionStore, operations),
      { initialProps: { sessionStore: new SessionStore({ sessionId: SESSION_ID }) } },
    );
    await attachOnce(rendered.result.current.attach);
    expect(rendered.result.current.reading.act.status).toBe("attached");

    rendered.rerender({ sessionStore: new SessionStore({ sessionId: SESSION_ID }) });

    // A fresh controller has sent nothing, where the retired one still held the
    // settlement it read against the store that is gone.
    expect(rendered.result.current.reading.act.status).toBe("idle");
  });

  it("disposes the controller the swap replaced, once, and keeps the new one live", async () => {
    // A controller replaced but never disposed would go on holding a session projection
    // nothing on screen is drawn from; one that disposed the new controller instead
    // could not publish the attach below.
    const disposals = vi.spyOn(AttachController.prototype, "dispose");
    try {
      const bridge = bridgeOnClock();
      const operations = scriptedRepoOperations({ attachRepository: attachRepository() });
      const rendered = renderHook(
        ({ sessionStore }) => useAttachController(bridge, sessionStore, operations),
        { initialProps: { sessionStore: new SessionStore({ sessionId: SESSION_ID }) } },
      );
      expect(disposals).not.toHaveBeenCalled();

      rendered.rerender({ sessionStore: new SessionStore({ sessionId: SESSION_ID }) });

      expect(disposals).toHaveBeenCalledTimes(1);

      await attachOnce(rendered.result.current.attach);
      expect(rendered.result.current.reading.act.status).toBe("attached");
    } finally {
      disposals.mockRestore();
    }
  });

  it("negative control: a store standing still rebinds nothing", async () => {
    // Without this the case above would pass against a binding that re-opened a
    // controller on every render, which would lose the settlement on each pass.
    const bridge = bridgeOnClock();
    const operations = scriptedRepoOperations({ attachRepository: attachRepository() });
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const rendered = renderHook(({ held }) => useAttachController(bridge, held, operations), {
      initialProps: { held: sessionStore },
    });
    await attachOnce(rendered.result.current.attach);

    rendered.rerender({ held: sessionStore });
    rendered.rerender({ held: sessionStore });

    expect(rendered.result.current.reading.act.status).toBe("attached");
  });
});
