// One mode switch per workspace on the wire at a time. Driven through
// `RepoMountsReader.requestModeSelection`, the one seam a view has, with the daemon's mode
// select parked so a case can observe the window between a press and its answer.

import type { ExecutionMode, WorkspaceId } from "@ai-sidekicks/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { ParkedCalls } from "@test/helpers/held-calls.js";
import type { RepoOperations } from "../repo-operations.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { RepoMountsReader } from "./repo-mounts-reader.js";
import {
  HEALTHY_WORKSPACE_ID,
  SESSION_ID,
  disposeTrackedReaders,
  sessionOperations,
  settle,
  trackReader,
} from "./repo-mounts.test-support.js";

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
  it("names the mode it sent while the daemon has not answered", async () => {
    const { reader } = await openWithHeldSelect();

    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();

    // The mode, not a flag: the rows keep showing the current mode, so a picker that only
    // grayed out would report nothing about what was pressed.
    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBe(WORKTREE_MODE);
  });

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
    // An accepted switch re-reads because the workspace goes `ready -> provisioning -> ready`.
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

  it("negative control: another workspace's switch is not held", async () => {
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

  it("releases the picker and the key, re-reads nothing, and passes the rejection on", async () => {
    const { reader, port } = await openWithHeldSelect("rejected");
    const pressed = reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    const outcome = expect(pressed).rejects.toThrow("The daemon could not be reached.");
    await crossMacrotaskBoundary();
    const readsBefore = reader.performCount;

    port.release();
    await outcome;

    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBeUndefined();
    expect(reader.inFlightSelectionCount).toBe(0);
    expect(reader.performCount).toBe(readsBefore);
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

  it("negative control: a reply landing after the section unmounted writes nothing", async () => {
    // Settled by liveness and request identity together; the release in the `finally` is the
    // write that would move the snapshot on a torn-down section.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    const readingBefore = reader.snapshot;

    reader.dispose();
    port.release();
    await crossMacrotaskBoundary();

    expect(reader.snapshot).toBe(readingBefore);
  });
});

describe("ExecutionModeSelections — the register empties on every exit", () => {
  it("holds one key while a switch is on the wire and none once it settles", async () => {
    const { reader, port } = await openWithHeldSelect();
    expect(reader.inFlightSelectionCount).toBe(0);

    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    expect(reader.inFlightSelectionCount).toBe(1);

    port.release();
    await crossMacrotaskBoundary();

    // A give-back that misses on one exit leaks a key, and that row then drops every later
    // press while the cases above keep passing.
    expect(reader.inFlightSelectionCount).toBe(0);
  });

  it("negative control: two workspaces in flight hold two keys, and each is its own", async () => {
    // Without this a one-key register would satisfy both cases above.
    const { reader, port } = await openWithHeldSelect();
    void reader.requestModeSelection(HEALTHY_WORKSPACE, WORKTREE_MODE);
    await crossMacrotaskBoundary();
    void reader.requestModeSelection(UNREACHABLE_WORKSPACE, BOUND_ROOT_MODE);
    await crossMacrotaskBoundary();

    expect(reader.inFlightSelectionCount).toBe(2);

    port.release();
    await crossMacrotaskBoundary();
    expect(reader.inFlightSelectionCount).toBe(0);
  });
});
