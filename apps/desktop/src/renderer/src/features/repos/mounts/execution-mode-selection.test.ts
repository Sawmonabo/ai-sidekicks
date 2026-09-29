// One mode switch per workspace on the wire at a time.
//
// Driven through `RepoMountsReader.requestModeSelection`, which is the one seam a view
// has: the selections are constructed by the reader and handed its host, so a case that
// built an `ExecutionModeSelections` over a hand-written host would be asserting against a
// host the console never composes.
//
// The daemon is scripted with one call held open. Every read a case makes is answered at
// once, and only the mode select is parked, because the whole subject here is what happens
// between a press and its answer, a window a call that settles immediately has no way to
// open.

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

// Every reader a case opens is tracked, and none of them outlives its case.
afterEach(disposeTrackedReaders);

/** The daemon with its mode-select call parked, and the two handles for it. */
interface HeldModeSelect {
  readonly operations: RepoOperations;
  /** How many selects actually reached the daemon — the "no second call" assertion. */
  readonly selectCallCount: () => number;
  /** Let every parked select through, in the order they were made. */
  readonly release: () => void;
}

/** What a released select answers. */
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

/** A section that has read, with its mode-select call parked. */
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

    // THE MODE AND NOT A FLAG: the rows go on showing the mode the workspace is bound
    // as now, so a picker that only grayed out would report nothing about what was
    // pressed.
    expect(reader.snapshot.pendingModeByWorkspaceId[HEALTHY_WORKSPACE_ID]).toBe(WORKTREE_MODE);
  });

  it("sends no second selection while one is unanswered", async () => {
    // Two selects issued before the first settles both run, and whichever reaches the
    // daemon last decides what the workspace is bound as — so a corrected choice could
    // lose to the one it corrected away from, silently, with both calls reporting success.
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
    // Absent, never a held key with no value: the picker asks whether there IS an entry.
    expect(Object.keys(reader.snapshot.pendingModeByWorkspaceId)).toStrictEqual([]);
    // An accepted switch re-reads, because the workspace transitions
    // `ready -> provisioning -> ready` on its existing id and the row has to follow it.
    clock.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
    expect(reader.performCount).toBe(readsBefore + 1);
  });

  it("accepts the corrected choice once the first has settled", async () => {
    // The user's correction is not lost: it waits for a picker that comes back.
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
    // The register is keyed per workspace on purpose. Without this case a section-wide
    // register would satisfy every assertion above while dropping a press on a row that
    // cannot collide with the one waiting.
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
    // A read is published beside a mutation it knows nothing about: a publish that rebuilt
    // the pending map would release the picker before the switch it is holding for settled.
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
    // Settled by liveness AND by request identity, asked in one place. The release in the
    // `finally` is the write that would move the snapshot, so a continuation that
    // published on a torn-down section would show here.
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

    // A give-back that misses on one exit leaks a key, and the row it belongs to then
    // drops every later press for the life of the section while every case above goes on
    // passing. That is the property a hand-rolled register loses first.
    expect(reader.inFlightSelectionCount).toBe(0);
  });

  it("negative control: two workspaces in flight hold two keys, and each is its own", async () => {
    // Without this a register that held one key for the whole section would satisfy
    // both cases above while dropping a press on a row that cannot collide.
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
