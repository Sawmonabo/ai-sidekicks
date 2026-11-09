// The bind act over a scripted call: what it sends, and how the reply settles.

import { afterEach, describe, expect, it } from "vitest";

import type {
  WorkspaceBindRequest,
  WorkspaceBindResponse,
} from "@ai-sidekicks/contracts/repo/workspace";

import { scriptedRepoOperations } from "../../operations.test-support.js";
import { BindWorkspaceController } from "./controller.js";

const controllers: BindWorkspaceController[] = [];

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("BindWorkspaceController", () => {
  it("binds its own session on its own mount, leaving out an unnamed directory", async () => {
    // An empty `directory` is refused by the parser, so a bind at the mount root omits it.
    const requests: WorkspaceBindRequest[] = [];
    const controller = new BindWorkspaceController({
      operations: scriptedRepoOperations({
        bindWorkspace: (request) => {
          requests.push(request);
          return Promise.resolve({
            workspaceId: "workspace-new",
            executionMode: request.executionMode,
            state: "preparing",
          } as unknown as WorkspaceBindResponse);
        },
      }),
      sessionId: "session-repos",
      repoMountId: "mount-sidekicks",
    });
    controllers.push(controller);

    await controller.bind("provisionedWorktree", undefined);
    await controller.bind("boundRoot", "packages/contracts");

    expect(requests).toStrictEqual([
      {
        sessionId: "session-repos",
        repoMountId: "mount-sidekicks",
        executionMode: "provisionedWorktree",
      },
      {
        sessionId: "session-repos",
        repoMountId: "mount-sidekicks",
        executionMode: "boundRoot",
        directory: "packages/contracts",
      },
    ]);
    const reading = controller.snapshot;
    expect(reading.status === "bound" && reading.response.workspaceId).toBe("workspace-new");
  });
});
