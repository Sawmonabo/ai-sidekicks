// One mode switch per workspace on the wire at a time. Driven through
// `RepoMountsReader.requestModeSelection`, the one seam a view has, with the daemon's mode
// select parked so a case can observe the window between a press and its answer.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts/repo/repo";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "#renderer/lib/reads/refresh/caps.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { ParkedCalls } from "#test/helpers/held-calls.js";
import type { RepoOperations } from "../../repo-operations.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import { RepoMountsReader } from "../repo-mounts-reader.js";
import {
  HEALTHY_WORKSPACE_ID,
  SESSION_ID,
  disposeTrackedReaders,
  sessionOperations,
  settle,
  trackReader,
} from "../repo-mounts.test-support.js";

afterEach(disposeTrackedReaders);

interface HeldModeSelect {
  readonly operations: RepoOperations;
  readonly selectCallCount: () => number;
  readonly release: () => void;
}

type ReleasedSelect = "served" | "rejected";

function daemonHoldingModeSelect(released: ReleasedSelect = "served"): HeldModeSelect {
  const parked = new ParkedCalls();
  let calls = 0;
  return {
    operations: sessionOperations({
      selectExecutionMode: async (workspaceId, executionMode) => {
        calls += 1;
        await parked.park();
        if (released === "rejected") {
          throw new Error("The daemon could not be reached.");
        }
        return { workspaceId, executionMode, state: "ready" };
      },
    }),
    selectCallCount: () => calls,
    release: () => {
      parked.releaseAll();
    },
  };
}

async function openWithHeldSelect(released: ReleasedSelect = "served"): Promise<{
  reader: RepoMountsReader;
  clock: ManualClock;
  port: HeldModeSelect;
}> {
  const clock = new ManualClock();
  const port = daemonHoldingModeSelect(released);
  const reader = new RepoMountsReader({
    operations: port.operations,
    sessionStore: new SessionStore({ sessionId: SESSION_ID }),
    ownerWindow: window,
    clock,
  });
  trackReader(reader);
  reader.start();
  await settle(clock, reader);
  return { reader, clock, port };
}

const HEALTHY_WORKSPACE = HEALTHY_WORKSPACE_ID as WorkspaceId;
const UNREACHABLE_WORKSPACE = "workspace-unreachable" as WorkspaceId;
const WORKTREE_MODE = "provisioned-worktree" satisfies ExecutionMode;
const BOUND_ROOT_MODE = "bound-root" satisfies ExecutionMode;

describe("ExecutionModeSelections — one switch per workspace at a time", () => {
  it("sends no second selection while one is unanswered", async () => {
    // Two selects issued before the first settles both run and the last to reach the daemon
    // decides, so a corrected choice could silently lose to the one it corrected away from.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();

    await reader.requestModeSelection(HEALTHY_WORKSPACE, BOUND_ROOT_MODE);

    expect(port.selectCallCount()).toBe(1);
    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBe(WORKTREE_MODE);
  });

  it("releases the picker and re-reads once the held switch settles", async () => {
    const { reader, clock, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    const readsBefore = reader.performCount;

    port.release();
    await crossMacrotaskBoundary();

    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBeUndefined();
    // Absent, never a held key with no value: the picker asks whether there is an entry.
    expect(Object.keys(reader.snapshot.pendingModeByWorkspaceId)).toStrictEqual([]);
    // An accepted switch re-reads because the workspace goes `ready -> preparing -> ready`.
    clock.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
    expect(reader.performCount).toBe(readsBefore + 1);
  });

  it("accepts the corrected choice once the first has settled", async () => {
    // The correction is not lost: it waits for a picker that comes back.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    port.release();
    await crossMacrotaskBoundary();

    void reader.requestModeSelection(HEALTHY_WORKSPACE, BOUND_ROOT_MODE);
    await crossMacrotaskBoundary();

    expect(port.selectCallCount()).toBe(2);
    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBe(BOUND_ROOT_MODE);
  });

  it("does not hold another workspace's switch", async () => {
    // Keyed per workspace: a section-wide register would drop a press on an independent row.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();

    void reader.requestModeSelection(UNREACHABLE_WORKSPACE, BOUND_ROOT_MODE);
    await crossMacrotaskBoundary();

    expect(port.selectCallCount()).toBe(2);
    expect(reader.snapshot.pendingModeByWorkspaceId).toStrictEqual({
      [HEALTHY_WORKSPACE_ID]: WORKTREE_MODE,
      [UNREACHABLE_WORKSPACE]: BOUND_ROOT_MODE,
    });
  });

  it("draws the refusal on its workspace, frees the picker and key, re-reads nothing", async () => {
    const { reader, clock, port } = await openWithHeldSelect("rejected");
    const pressed = reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    const readsBefore = reader.performCount;

    port.release();
    await pressed;
    clock.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();

    expect(reader.snapshot.refusedModeByWorkspaceId[HEALTHY_WORKSPACE_ID]?.detail).toBe(
      "The daemon could not be reached.",
    );
    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBeUndefined();
    expect(reader.performCount).toBe(readsBefore);
    // The key is free: the next press reaches the wire, and sending it clears the refusal.
    const pressedAgain = reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    expect(port.selectCallCount()).toBe(2);
    expect(reader.snapshot.refusedModeByWorkspaceId).toStrictEqual({});
    port.release();
    await pressedAgain;
  });

  it("keeps the picker held when a read lands while the switch is on the wire", async () => {
    // A read published beside a mutation must not rebuild the pending map, which would release
    // the picker before the switch settles.
    const { reader, clock, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    const readsBefore = reader.performCount;

    reader.requestRead("user-request");
    await settle(clock, reader);

    expect(reader.performCount).toBe(readsBefore + 1);
    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBe(WORKTREE_MODE);

    port.release();
    await crossMacrotaskBoundary();
  });
});
