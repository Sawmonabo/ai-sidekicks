// Why the mounts read again: the reasons that start a second read, how a burst coalesces into
// one call, and that disposal leaves none able to fire.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import {
  SESSION_ID,
  disposeTrackedReaders,
  openReader,
  sessionOperations,
  settle,
} from "./repo-mounts.test-support.js";

afterEach(disposeTrackedReaders);

/**
 * One `workspace.stale` frame, payload-free because the trigger keys on the kind alone; the
 * envelope comes from the shared session-events helper.
 */
function staleFrame(sessionId: string, sequence: number): ProjectedSessionEvent {
  return eventOfKind(sessionId, "workspace.stale", sequence);
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
function initializedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialize({ cursor: 0, entities: [] });
  return sessionStore;
}

describe("RepoMountsReader — the reasons it reads again", () => {
  it("re-reads on a `workspace.stale` frame", async () => {
    // Without this refresh reason, a path that went stale while the window stayed focused would
    // leave the mount health, workspace states, roots and mode controls on the first read.
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

  it("coalesces two frames in one window into one read", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore(SESSION_ID);
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.applyBatch([staleFrame(SESSION_ID, 1), staleFrame(SESSION_ID, 2)]);
    await settle(clock, reader);

    // Two reasons inside one debounce window are one read: several workspaces going stale at
    // once cost one burst.
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

  it("re-reads on the terminal frame a provisioning workspace settles with", async () => {
    // An accepted mode select answers `preparing` with no execution root, and the daemon later
    // emits `workspace.ready` carrying it; without watching that frame the row stayed
    // provisioning until a focus, a reconnect or another mutation.
    const clock = new ManualClock();
    const sessionStore = initializedStore(SESSION_ID);
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);
    const readAtFirstSettle = reader.snapshot.readAtMilliseconds;
    expect(reader.performCount).toBe(1);

    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workspace.ready", 1)]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
    // The stamp moves only on a re-read, which installs whatever execution root the daemon now
    // names.
    expect(reader.snapshot.readAtMilliseconds).toBeGreaterThan(readAtFirstSettle);
  });

  it("re-reads when a workspace leaves the session", async () => {
    // The section learns its mounts from its workspaces, so `workspace.archived` changes the
    // mount list it draws.
    const clock = new ManualClock();
    const sessionStore = initializedStore(SESSION_ID);
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workspace.archived", 1)]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("coalesces a burst across the whole namespace into one read", async () => {
    // A workspace reprovisioning emits several frames in one breath: one burst, not four reads.
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

  it("negative control: an ordinary frame and a base state ask for nothing", async () => {
    // Without this every case above would pass against a reader that re-read on any store
    // transition, which is interval polling with extra steps.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    const reader = openReader(sessionOperations(), clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.initialize({
      cursor: 1,
      entities: [],
      // A stale frame inside the backfill is history the live read already reflects.
      timeline: [staleFrame(SESSION_ID, 1)],
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
  it("is terminal: a disposed reader arms nothing and reads nothing more", async () => {
    const clock = new ManualClock();
    const reader = openReader(sessionOperations(), clock);
    reader.start();
    await settle(clock, reader);
    const performedBeforeDispose = reader.performCount;

    reader.dispose();
    window.dispatchEvent(new Event("focus"));
    clock.advance(REFRESH_DEBOUNCE_MS * 10);
    await Promise.resolve();

    expect(reader.performCount).toBe(performedBeforeDispose);
    // No timer outlives the section that armed it.
    expect(clock.pendingCount).toBe(0);
  });
});
