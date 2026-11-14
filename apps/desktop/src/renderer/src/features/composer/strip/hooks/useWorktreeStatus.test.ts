// A root picked before the tree read lands is named by that read: closing the popover lets the
// read finish instead of abandoning it, so the chip names the root's branch.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorktreeStatusReadResponse } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { bridgeOnClock, withDaemonCall } from "#test/helpers/fixture/bridge.js";
import { handAnsweredCall } from "#test/helpers/held-calls.js";
import { useWorktreeStatus } from "./useWorktreeStatus.js";

const PROJECT_ID = "019b7892-1a00-7c31-8110-cca0117a07ff" as ProjectId;
const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5" as SessionId;

const STATUS: WorktreeStatusReadResponse = {
  repoRoot: { path: "/work/atlas", branchName: "main" },
  worktrees: [],
};

describe("the worktree read", () => {
  it("finishes a read a picked root waits on after the popover closes", async () => {
    const statusRead = handAnsweredCall<WorktreeStatusReadResponse>();
    const { bridge, calls } = withDaemonCall(
      bridgeOnClock("worktree-status").bridge,
      async (call, passThrough) =>
        call.method === "worktree.status.read" ? await statusRead.invoke() : await passThrough(),
    );
    const { result, rerender } = renderHook(
      (props: { readonly isOpen: boolean; readonly isRootNameAwaited: boolean }) =>
        useWorktreeStatus(bridge, PROJECT_ID, SESSION_ID, props.isOpen, props.isRootNameAwaited),
      { initialProps: { isOpen: true, isRootNameAwaited: false } },
    );
    // The call goes out once the method's checks have loaded.
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    rerender({ isOpen: true, isRootNameAwaited: true });
    rerender({ isOpen: false, isRootNameAwaited: true });
    await act(async () => {
      statusRead.open(STATUS);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(result.current.reading).toStrictEqual({ kind: "loaded", status: STATUS });
    });
    expect(calls).toHaveLength(1);
  });
});
