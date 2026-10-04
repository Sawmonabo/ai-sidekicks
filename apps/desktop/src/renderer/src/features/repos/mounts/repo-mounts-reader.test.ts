// The read: what it asks, the reasons it reads again, how a burst coalesces into one call, and
// that disposal leaves none able to fire. The real reader runs over scripted calls on a frozen
// clock.

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { initializedStore } from "@test/helpers/session-store-fixtures.js";
import {
  ALL_MODES_CAPABILITIES,
  CANONICAL_ROOT,
  DRIFTED_MOUNT_ID,
  HEALTHY_MOUNT_ID,
  HEALTHY_WORKSPACE_ID,
  SESSION_ID,
  UNREACHABLE_MOUNT_ID,
  WORKSPACES,
  disposeTrackedReaders,
  openReader,
  sessionOperations,
  settle,
  workspaceRow,
  worktreeRecord,
} from "./repo-mounts.test-support.js";

afterEach(disposeTrackedReaders);

/**
 * One `workspace.stale` frame, payload-free because the trigger keys on the kind alone; the
 * envelope comes from the shared session-events helper.
 */
function staleFrame(sessionId: string, sequence: number): ProjectedSessionEvent {
  return eventOfKind(sessionId, "workspace.stale", sequence);
}

describe("RepoMountsReader — the read", () => {
  it("learns the mounts from the listed workspaces and reads each one for health", async () => {
    const clock = new ManualClock();
    const reader = openReader(sessionOperations(), clock);
    expect(reader.snapshot.status).toBe("not-read");

    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.status).toBe("read");
    expect(reading.workspaces).toHaveLength(3);
    // The workspace list is where the mounts come from, and the mount read is the only call
    // that carries `health`. One read per distinct mount, each answering about the mount it named.
    expect(reading.mounts.map((mount) => mount.id)).toStrictEqual(
      reading.workspaces.map((row) => row.repoMountId),
    );
    expect(reading.mounts.map((mount) => mount.health.status)).toStrictEqual([
      "healthy",
      "unreachable",
      "identity_mismatch",
    ]);
  });

  it("returns to where it stood when a call is refused, rather than reading forever", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      sessionOperations({
        listWorkspaces: () => Promise.reject(new Error("The background service is not answering.")),
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.status).toBe("not-read");
  });

  it("reads each workspace's own execution-mode capabilities", async () => {
    // Each workspace answers a different default, so an answer filed under another workspace's
    // id shows.
    const clock = new ManualClock();
    const reader = openReader(
      sessionOperations({
        readWorkspaceExecutionModes: (workspaceId) =>
          Promise.resolve({
            ...ALL_MODES_CAPABILITIES,
            defaultMode:
              workspaceId === HEALTHY_WORKSPACE_ID ? "provisioned-worktree" : "bound-root",
          }),
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // One answer per workspace, keyed by the list's own ids.
    expect(Object.keys(reading.capabilitiesByWorkspaceId).sort()).toStrictEqual(
      reading.workspaces.map((row) => row.id).sort(),
    );
    for (const row of reading.workspaces) {
      expect(reading.capabilitiesByWorkspaceId[row.id]?.defaultMode).toBe(
        row.id === HEALTHY_WORKSPACE_ID ? "provisioned-worktree" : "bound-root",
      );
    }
  });

  it("reads a mount two workspaces share once, and lists it once", async () => {
    const mountsRead: string[] = [];
    const operations = sessionOperations({
      listWorkspaces: () =>
        Promise.resolve({
          workspaces: [
            ...WORKSPACES,
            workspaceRow({ id: "workspace-second", repoMountId: HEALTHY_MOUNT_ID }),
          ],
        }),
    });
    const readMount = operations.readMount;
    const clock = new ManualClock();
    const reader = openReader(
      {
        ...operations,
        readMount: async (repoMountId, signal) => {
          mountsRead.push(repoMountId);
          return await readMount(repoMountId, signal);
        },
      },
      clock,
    );
    reader.start();
    await settle(clock, reader);

    expect(mountsRead.sort()).toStrictEqual(
      [DRIFTED_MOUNT_ID, HEALTHY_MOUNT_ID, UNREACHABLE_MOUNT_ID].sort(),
    );
    expect(reader.snapshot.mounts.map((mount) => mount.id).sort()).toStrictEqual(
      [DRIFTED_MOUNT_ID, HEALTHY_MOUNT_ID, UNREACHABLE_MOUNT_ID].sort(),
    );
  });

  it("reads the worktrees of every bound mount, mount by mount", async () => {
    // The status read is keyed by one project's folder, so three mounts mean three calls.
    const clock = new ManualClock();
    const reader = openReader(
      sessionOperations({
        readWorktreeStatus: (repoMountId) =>
          Promise.resolve({
            repoRoot: { path: CANONICAL_ROOT, branchName: "main" },
            worktrees: [
              worktreeRecord({
                worktreeId: `worktree-on-${repoMountId}`,
                repoMountId,
              }),
            ],
          }),
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.worktrees.map((record) => record.worktreeId)).toStrictEqual([
      `worktree-on-${HEALTHY_MOUNT_ID}`,
      `worktree-on-${UNREACHABLE_MOUNT_ID}`,
      `worktree-on-${DRIFTED_MOUNT_ID}`,
    ]);
  });
});

describe("RepoMountsReader — the reasons it reads again", () => {
  it("re-reads on a `workspace.stale` frame", async () => {
    // A path that went stale while the window stayed focused would otherwise leave the mount
    // health, workspace states, roots and mode controls on the first read.
    const clock = new ManualClock();
    const sessionStore = initializedStore(SESSION_ID);
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.applyBatch([staleFrame(SESSION_ID, 1)]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("re-reads when the session's projection is repaired", async () => {
    // The console publishes no bridge-level reconnect event; `degradedCause` clears only after a
    // completed re-pull, so its clearing edge is the observed reconnect.
    const clock = new ManualClock();
    const sessionStore = initializedStore(SESSION_ID);
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.markDegraded("subscription-closed");
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.initialize({ cursor: 0, entities: [] });
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("coalesces a burst across the whole namespace into one read", async () => {
    // A workspace preparing again emits several frames in one breath: one burst, not four reads.
    const clock = new ManualClock();
    const sessionStore = initializedStore(SESSION_ID);
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.applyBatch([
      eventOfKind(SESSION_ID, "workspace.preparing", 1),
      eventOfKind(SESSION_ID, "worktree.created", 2),
      eventOfKind(SESSION_ID, "worktree.ready", 3),
      eventOfKind(SESSION_ID, "workspace.ready", 4),
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("asks for nothing on an ordinary frame or a base state", async () => {
    // A reader that re-read on any store transition would be interval polling with extra steps.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.initialize({
      cursor: 1,
      entities: [],
      // A stale frame inside the backfill is history the live read already reflects.
      transcript: [staleFrame(SESSION_ID, 1)],
    });
    sessionStore.applyBatch([
      {
        id: "event-2",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "run.queued",
        occurredAt: "2026-01-01T09:05:02.000Z",
      },
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(1);
  });
});

describe("RepoMountsReader — teardown", () => {
  it(
    "is terminal: a disposed reader arms nothing, reads nothing " + "more, and stops listening",
    async () => {
      const added = vi.spyOn(window, "addEventListener");
      const removed = vi.spyOn(window, "removeEventListener");
      onTestFinished(() => {
        added.mockRestore();
        removed.mockRestore();
      });
      const clock = new ManualClock();
      const reader = openReader(sessionOperations(), clock);
      reader.start();
      await settle(clock, reader);
      // A read armed and not yet fired when the section unmounts.
      reader.requestRead("window-focus");
      const performedBeforeDispose = reader.performCount;

      reader.dispose();
      window.dispatchEvent(new Event("focus"));
      clock.advance(REFRESH_DEBOUNCE_MS * 10);
      await Promise.resolve();

      expect(reader.performCount).toBe(performedBeforeDispose);
      // No timer outlives the section that armed it.
      expect(clock.pendingCount).toBe(0);
      // Nor a focus listener holding the reader alive.
      const focusListeners = (calls: readonly unknown[][]): unknown[] =>
        calls.filter(([type]) => type === "focus").map(([, listener]) => listener);
      expect(focusListeners(added.mock.calls)).toHaveLength(1);
      expect(focusListeners(removed.mock.calls)).toStrictEqual(focusListeners(added.mock.calls));
    },
  );
});
