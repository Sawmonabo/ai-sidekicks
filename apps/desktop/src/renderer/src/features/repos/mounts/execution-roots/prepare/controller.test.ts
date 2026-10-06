// Preparing an execution root over a scripted call.

import { afterEach, describe, expect, it } from "vitest";

import { scriptedRepoOperations } from "#renderer/features/repos/operations.test-support.js";
import { preparingDaemon } from "../../repo-mounts.test-support.js";
import { ExecutionRootPrepareController, type PrepareOperations } from "./controller.js";

const controllers: ExecutionRootPrepareController[] = [];

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("ExecutionRootPrepareController", () => {
  it("prepares its own workspace on the named branch and publishes the root on disk", async () => {
    // `ready`, not `preparing`: the execution-root service awaits the preparation's completion
    // before answering, so "prepared / preparing" is a pair no daemon can send.
    const daemon = preparingDaemon();
    const prepares: Parameters<PrepareOperations["prepareExecutionRoot"]>[0][] = [];
    const controller = new ExecutionRootPrepareController({
      operations: scriptedRepoOperations({
        prepareExecutionRoot: async (request) => {
          prepares.push(request);
          return await daemon.prepareExecutionRoot(request);
        },
      }),
      workspaceId: "workspace-sidekicks",
    });
    controllers.push(controller);

    await controller.prepare("feat/fresh-root");

    expect(prepares).toStrictEqual([
      { workspaceId: "workspace-sidekicks", branchName: "feat/fresh-root" },
    ]);
    const reading = controller.snapshot;
    expect(reading.status).toBe("prepared");
    expect(reading.status === "prepared" && reading.executionRoot.length).toBeGreaterThan(0);
    expect(reading.status === "prepared" && reading.state).toBe("ready");
  });
});
