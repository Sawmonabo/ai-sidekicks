// The inventory composes two registered reads, settles each mount independently,
// and never asks for more mounts than its cap.

import type { RepoMountReadResponse, WorkspaceListResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, ManualClock, refuse } from "../../core/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { MOUNT_INVENTORY_READ_CAP } from "../../collaboration/constants.js";
import { createMountInventoryRead, distinctMountIds } from "./mount-inventory.js";

/**
 * Let the scheduler's in-flight read settle without advancing the clock.
 *
 * One turn of the macrotask queue rather than a counted run of microtask flushes:
 * this read awaits a list, then a `Promise.allSettled` over as many mounts as the
 * cap admits, so the number of microtask ticks it takes is a function of the
 * fixture rather than a constant, and a counted flush would pass on two mounts and
 * silently under-settle on twenty.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function workspaceListWith(mountIds: readonly string[]): WorkspaceListResponse {
  return {
    workspaces: mountIds.map((repoMountId, index) => ({
      id: `workspace-${String(index)}` as WorkspaceListResponse["workspaces"][number]["id"],
      repoMountId: repoMountId as WorkspaceListResponse["workspaces"][number]["repoMountId"],
      executionMode: "worktree",
      state: "ready",
    })),
  };
}

function mountReadFor(repoMountId: string): RepoMountReadResponse {
  return {
    id: repoMountId as RepoMountReadResponse["id"],
    sessionId: "session-1" as RepoMountReadResponse["sessionId"],
    nodeId: "node-1" as RepoMountReadResponse["nodeId"],
    localPath: `/repos/${repoMountId}`,
    canonicalRoot: `/repos/${repoMountId}`,
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-09-02T10:00:00.000Z" },
    attachedAt: "2026-09-01T10:00:00.000Z",
  };
}

/**
 * A bridge whose daemon call answers the two registered methods and records every
 * call it was asked to make.
 *
 * The CALL is stubbed and the inventory is real — the module under test composes
 * the two reads, and that composition is what is being asserted.
 */
function bridgeAnswering(options: {
  readonly mountIds: readonly string[];
  readonly refuseMountIds?: readonly string[];
}): { bridge: ConsoleBridge; calls: { method: string; request: unknown }[] } {
  const calls: { method: string; request: unknown }[] = [];
  const bridge = {
    source: "fixture",
    sidekicks: {
      daemon: {
        call: async (method: string, request: unknown): Promise<unknown> => {
          calls.push({ method, request });
          if (method === "repo.workspaceList") {
            return workspaceListWith(options.mountIds);
          }
          const { repoMountId } = request as { repoMountId: string };
          if (options.refuseMountIds?.includes(repoMountId) === true) {
            throw new ConsoleRefusalError(
              refuse("daemon", "repo.mount_not_found", `No mount ${repoMountId}.`),
            );
          }
          return mountReadFor(repoMountId);
        },
      },
    },
  } as unknown as ConsoleBridge;
  return { bridge, calls };
}

describe("distinct mount ids", () => {
  it("names each mount once, in a stable order", () => {
    const ids = distinctMountIds(workspaceListWith(["mount-b", "mount-a", "mount-b"]));
    expect(ids).toStrictEqual(["mount-a", "mount-b"]);
  });

  it("negative control: reply order alone would not be stable", () => {
    // The sort is the claim. Two replies listing the same mounts in different
    // orders must produce one row order, or a row moves when an unrelated
    // workspace is created.
    const first = distinctMountIds(workspaceListWith(["mount-b", "mount-a"]));
    const second = distinctMountIds(workspaceListWith(["mount-a", "mount-b"]));
    expect(first).toStrictEqual(second);
  });
});

describe("mount inventory read", () => {
  it("reads each distinct mount once, after listing the session's workspaces", async () => {
    const clock = new ManualClock();
    const { bridge, calls } = bridgeAnswering({ mountIds: ["mount-a", "mount-b", "mount-a"] });
    const read = createMountInventoryRead({ bridge, sessionId: "session-1", clock });
    read.start();
    clock.advance(500);
    await settle();
    expect(calls[0]?.method).toBe("repo.workspaceList");
    expect(calls.filter((call) => call.method === "repo.mountRead")).toHaveLength(2);
    expect(read.state.kind).toBe("loaded");
    read.dispose();
    expect(clock.pendingCount).toBe(0);
  });

  it("keeps a refused mount as its own row rather than failing the list", async () => {
    const clock = new ManualClock();
    const { bridge } = bridgeAnswering({
      mountIds: ["mount-a", "mount-b"],
      refuseMountIds: ["mount-b"],
    });
    const read = createMountInventoryRead({ bridge, sessionId: "session-1", clock });
    read.start();
    clock.advance(500);
    await settle();
    const state = read.state;
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") {
      return;
    }
    expect(state.value.readings.map((reading) => reading.kind)).toStrictEqual(["read", "refused"]);
    const refused = state.value.readings[1];
    expect(refused?.kind === "refused" ? refused.refusal.code : undefined).toBe(
      "repo.mount_not_found",
    );
    read.dispose();
  });

  it("negative control: a failing workspace list fails the whole read", async () => {
    // The per-mount arms above are only meaningful because the LIST has no such
    // arm — there is no partial inventory when nothing named the mounts.
    const clock = new ManualClock();
    const bridge = {
      source: "fixture",
      sidekicks: {
        daemon: {
          call: async (): Promise<unknown> => {
            throw new Error("transport closed");
          },
        },
      },
    } as unknown as ConsoleBridge;
    const read = createMountInventoryRead({ bridge, sessionId: "session-1", clock });
    read.start();
    clock.advance(500);
    await settle();
    expect(read.state.kind).toBe("failed");
    read.dispose();
  });

  it("stops at the cap and reports how many it did not read", async () => {
    const clock = new ManualClock();
    const mountIds = Array.from(
      { length: MOUNT_INVENTORY_READ_CAP + 3 },
      (_unused, index) => `mount-${String(index).padStart(3, "0")}`,
    );
    const { bridge, calls } = bridgeAnswering({ mountIds });
    const read = createMountInventoryRead({ bridge, sessionId: "session-1", clock });
    read.start();
    clock.advance(500);
    await settle();
    const state = read.state;
    expect(calls.filter((call) => call.method === "repo.mountRead")).toHaveLength(
      MOUNT_INVENTORY_READ_CAP,
    );
    expect(state.kind === "loaded" ? state.value.unreadMountCount : undefined).toBe(3);
  });

  it("opens no subscription that would refresh it, and arms no timer once disposed", async () => {
    // The honest fact this module names: the settings context carries no session
    // store, so there is no push signal to open. What must still hold is that
    // nothing is left armed behind the page.
    const clock = new ManualClock();
    const { bridge } = bridgeAnswering({ mountIds: ["mount-a"] });
    const read = createMountInventoryRead({ bridge, sessionId: "session-1", clock });
    read.start();
    clock.advance(500);
    await settle();
    read.dispose();
    read.refresh("window-focus");
    expect(clock.pendingCount).toBe(0);
  });
});
