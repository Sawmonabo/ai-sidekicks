// Why the mounts read again, and what a teardown stops.
//
// WHAT ONE READ PUBLISHES is `repo-mounts-reader.test.ts` — the served arms and the
// answer that never came. Every case here is about a SECOND read: the reasons that
// start one, how a burst of them is coalesced into a single call, and the disposal
// that must leave none of them able to fire.

import { afterEach, describe, expect, it } from "vitest";

import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { openReader, settle, disposeTrackedReaders } from "./repo-mounts.test-support.js";

// Every reader a case opens is tracked, and none of them outlives its case.
afterEach(disposeTrackedReaders);

/**
 * One `workspace.stale` frame — the kind the section watched before it watched them all.
 *
 * The envelope itself is `store/session-event.test-support.ts`'s, which is where every
 * suite that needs an admitted event gets one. Named here only because the KIND is the
 * reading: the cases that drive this frame are about this kind arriving — and the
 * negative control is about it not being enough on its own — so spelling the string at
 * each of them would make the kind incidental to cases that are entirely about it.
 * Payload-free, because the trigger keys on the kind and on nothing else, and a frame
 * carrying members would suggest the section reads one — the wire's own payload shape
 * is `bridge/scenarios/repos.ts`'s to state, under the wire-truth predicate.
 */
function staleFrame(sessionId: string, sequence: number): ConsoleSessionEvent {
  return eventOfKind(sessionId, "workspace.stale", sequence);
}

/** A store with a base state, which is what makes a later frame a frame and not history. */
function initialisedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

describe("RepoMountsReader — the reasons it reads again", () => {
  it("re-reads on a `workspace.stale` frame", async () => {
    // The terminal-event refresh reason. Before it was wired, a path that went stale while
    // the window stayed focused left the mount health, the workspace states, the roots,
    // and the mode controls standing on the first read for as long as nobody clicked.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(REPOS_SCENARIO.sessionId);
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.applyBatch([staleFrame(REPOS_SCENARIO.sessionId, 1)]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("coalesces two frames in one window into one read", async () => {
    const clock = new ManualClock();
    const sessionStore = initialisedStore(REPOS_SCENARIO.sessionId);
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.applyBatch([
      staleFrame(REPOS_SCENARIO.sessionId, 1),
      staleFrame(REPOS_SCENARIO.sessionId, 2),
    ]);
    await settle(clock, reader);

    // The scheduler's job, asserted rather than assumed: two reasons inside one debounce
    // window are one read, so a session losing several workspaces at once costs one burst.
    expect(reader.performCount).toBe(2);
  });

  it("re-reads when the session's projection is repaired", async () => {
    // The console publishes no bridge-level reconnect event. What it publishes is
    // `degradedCause`, cleared only by a completed re-pull — so its clearing edge is the
    // observed moment the stream is whole again, which is what the policy calls reconnect.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(REPOS_SCENARIO.sessionId);
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.markDegraded("subscription-closed");
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("re-reads on the terminal frame a provisioning workspace settles with", async () => {
    // The gap this closes: an accepted mode select answers `provisioning` with no
    // execution root — the root does not exist yet — and the daemon emits
    // `workspace.ready` carrying it. Watching only `workspace.stale` left that reply
    // unread, so the row stayed provisioning until a focus, a reconnect, or another
    // mutation happened along.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(REPOS_SCENARIO.sessionId);
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);
    const readAtFirstSettle = reader.snapshot.readAtMilliseconds;
    expect(reader.performCount).toBe(1);

    sessionStore.applyBatch([eventOfKind(REPOS_SCENARIO.sessionId, "workspace.ready", 1)]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
    // The reading is the NEW read's rather than the old one redrawn: the stamp moves
    // only when the section re-reads, which is what installs whatever execution root
    // the daemon now names.
    expect(reader.snapshot.readAtMilliseconds).toBeGreaterThan(readAtFirstSettle);
  });

  it("re-reads when a mount leaves the session", async () => {
    // `repo.detached` changes the mount list this whole section is drawn from. Left
    // unwatched, the section went on drawing a mount card, its workspaces, and its
    // execution roots for a mount the session no longer holds.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(REPOS_SCENARIO.sessionId);
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.applyBatch([eventOfKind(REPOS_SCENARIO.sessionId, "repo.detached", 1)]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("coalesces a burst across the whole namespace into one read", async () => {
    // The widened set must not cost a read per frame: a workspace reprovisioning emits
    // several frames in one breath, and the scheduler is what makes that one burst
    // rather than five.
    const clock = new ManualClock();
    const sessionStore = initialisedStore(REPOS_SCENARIO.sessionId);
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.applyBatch([
      eventOfKind(REPOS_SCENARIO.sessionId, "workspace.provisioning", 1),
      eventOfKind(REPOS_SCENARIO.sessionId, "worktree.created", 2),
      eventOfKind(REPOS_SCENARIO.sessionId, "worktree.ready", 3),
      eventOfKind(REPOS_SCENARIO.sessionId, "workspace.ready", 4),
      eventOfKind(REPOS_SCENARIO.sessionId, "repo.attached", 5),
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("negative control: an ordinary frame and a base state ask for nothing", async () => {
    // Without this every case above would pass against a reader that re-read on any
    // store transition at all, which is interval polling with extra steps — and the
    // base-state arm would pass against one that re-read on its own session opening.
    const clock = new ManualClock();
    const sessionStore = new SessionStore({ sessionId: REPOS_SCENARIO.sessionId });
    const reader = openReader(REPOS_SCENARIO, clock, sessionStore);
    reader.start();
    await settle(clock, reader);

    sessionStore.initialise({
      cursor: 1,
      entities: [],
      participantJoinLog: [],
      // A stale frame inside the BACKFILL is history the section's own live read already
      // reflects, so establishing a base state re-reads nothing.
      timeline: [staleFrame(REPOS_SCENARIO.sessionId, 1)],
    });
    sessionStore.applyBatch([
      {
        id: "event-2",
        sessionId: REPOS_SCENARIO.sessionId,
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
    const reader = openReader(REPOS_SCENARIO, clock);
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
