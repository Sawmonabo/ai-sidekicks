// The attach act: the call it makes and what it publishes, through the real controller over a
// scripted attach call that records what it was asked.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { RepoAttachResponse } from "@ai-sidekicks/contracts/repo/folders";

import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import type { RepoOperations } from "../../repo-operations.js";
import { AttachController } from "./controller.js";

/** What the daemon answers an attach with. */
const ATTACHED = {
  repoMountId: "mount-new",
  state: "attached",
  vcsType: "git",
  canonicalRoot: "/Users/dev/code/new-repo",
} as unknown as RepoAttachResponse;

/** An attach call that answers the minted mount. */
function attachRepository(): Mock<RepoOperations["attachRepository"]> {
  return vi.fn<RepoOperations["attachRepository"]>(() => Promise.resolve(ATTACHED));
}

const controllers: AttachController[] = [];

function open(call: Mock<RepoOperations["attachRepository"]>): AttachController {
  const controller = new AttachController({
    operations: scriptedRepoOperations({ attachRepository: call }),
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
  it("sends the path as typed and publishes the minted mount", async () => {
    const call = attachRepository();
    const controller = open(call);

    await controller.attach("/Users/dev/code/new-repo");

    expect(call).toHaveBeenCalledExactlyOnceWith({ localPath: "/Users/dev/code/new-repo" });
    const settlement = controller.snapshot;
    expect(settlement.status).toBe("attached");
    expect(settlement.status === "attached" && settlement.response.repoMountId).toBe("mount-new");
  });

  it("refuses to put a second attach on the wire for one intent", async () => {
    const call = attachRepository();
    const controller = open(call);

    const first = controller.attach("/Users/dev/code/new-repo");
    // The single-flight key is taken, so the second call returns without reaching the wire.
    await controller.attach("/Users/dev/code/other-repo");
    await first;

    expect(call).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.status).toBe("attached");
  });
});
