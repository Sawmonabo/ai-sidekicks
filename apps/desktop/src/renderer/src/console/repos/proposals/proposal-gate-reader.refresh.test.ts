// Why the gate reads again, what a teardown stops, and the roots it has no key for.
//
// WHAT ONE READ PUBLISHES is `proposal-gate-reader.test.ts` — one arm per outcome, and
// the proposal beside the context it was prepared for. Every case here is about a
// SECOND read: the reasons that start one, the disposal that must stop them all, and
// the mount shapes the registered read cannot be issued for at all.

import { afterEach, describe, expect, it } from "vitest";

import { REPOS_SCENARIO } from "../../bridge/scenarios/repos.js";
import { fixtureBridgeWithGrowth } from "../../bridge/fixture-bridge.test-support.js";
import { GIT_MOUNT_ID, GIT_WORKSPACE_ID } from "../../bridge/scenarios/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import type { ConsoleBridge, GrowthPort } from "../../bridge/index.js";
import {
  BRANCH_ROOT_UNADDRESSABLE_COPY,
  EPHEMERAL_CLONE_UNADDRESSABLE_COPY,
  type ProposalGateSubject,
} from "./proposal-gate-model.js";
import {
  OpenReaders,
  SERVED_CONTEXT,
  SUBJECT,
  gateBridgeAnswering,
  initialisedStore,
  settle,
} from "./proposal-gate-scripted-port.test-support.js";

const readers = new OpenReaders();

afterEach(() => {
  readers.disposeAll();
});

describe("ProposalGateReader — the reasons it reads again", () => {
  it("re-reads when the session's projection is repaired", async () => {
    // The reconnect refresh reason, which the gate had none of: a daemon that
    // reconnected while the window stayed focused left the branch context and the
    // prepared proposal standing, with `push` still offered against them.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reader = readers.open(
      gateBridgeAnswering({ branchContext: SERVED_CONTEXT }),
      clock,
      SUBJECT,
      sessionStore,
    );
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.markDegraded("subscription-closed");
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("re-reads on a `workspace.stale` frame", async () => {
    // The terminal-event refresh reason. A path that went stale in an already-focused window used
    // to leave the gate reporting a context the daemon had stopped standing behind.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reader = readers.open(
      gateBridgeAnswering({ branchContext: SERVED_CONTEXT }),
      clock,
      SUBJECT,
      sessionStore,
    );
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);

    sessionStore.applyBatch([
      {
        // The canonical envelope names the row as well as its position, so a frame
        // the store admits carries one.
        id: "event-1",
        sessionId: REPOS_SCENARIO.sessionId,
        sequence: 1,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:01.900Z",
      },
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(2);
  });

  it("negative control: a disposed gate re-reads on no later transition", async () => {
    // Without this the two cases above would pass against a reader whose triggers
    // outlived the component holding them, which is a read behind an unmounted gate.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reader = readers.open(
      gateBridgeAnswering({ branchContext: SERVED_CONTEXT }),
      clock,
      SUBJECT,
      sessionStore,
    );
    reader.start();
    await settle(clock, reader);
    const performedBeforeDispose = reader.performCount;

    reader.dispose();
    sessionStore.markDegraded("subscription-closed");
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    sessionStore.applyBatch([
      {
        id: "event-1",
        sessionId: REPOS_SCENARIO.sessionId,
        sequence: 1,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:02.900Z",
      },
    ]);
    await settle(clock, reader);

    expect(reader.performCount).toBe(performedBeforeDispose);
  });
});

describe("ProposalGateReader — teardown", () => {
  it("arms no timer of its own and leaves none behind", async () => {
    const clock = new ManualClock();
    const reader = readers.open(gateBridgeAnswering({ branchContext: SERVED_CONTEXT }), clock);
    reader.start();
    await settle(clock, reader);
    const performedBeforeDispose = reader.performCount;

    // A poll would fire here. The scheduler is the console's only timer and it re-arms
    // on a reason, so a long silence produces no read at all.
    clock.advance(REFRESH_DEBOUNCE_MS * 100);
    await Promise.resolve();
    expect(reader.performCount).toBe(performedBeforeDispose);

    reader.dispose();
    window.dispatchEvent(new Event("focus"));
    clock.advance(REFRESH_DEBOUNCE_MS * 10);
    await Promise.resolve();

    expect(reader.performCount).toBe(performedBeforeDispose);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("ProposalGateReader — the roots the registered read has no key for", () => {
  /** A port that counts, so "no call was made" is read rather than inferred. */
  function countingPort(): { readonly bridge: ConsoleBridge; readonly calls: () => number } {
    let calls = 0;
    return {
      bridge: fixtureBridgeWithGrowth(REPOS_SCENARIO, {
        gitflowBranchContextRead: async () => {
          calls += 1;
          return SERVED_CONTEXT;
        },
      } as unknown as Partial<GrowthPort>),
      calls: () => calls,
    };
  }

  const BRANCH_ROOT: ProposalGateSubject = {
    kind: "branch-root",
    workspaceId: GIT_WORKSPACE_ID,
    repoMountId: GIT_MOUNT_ID,
    executionMode: "branch",
  };

  const CLONE_ROOT: ProposalGateSubject = {
    kind: "ephemeral-clone",
    workspaceId: GIT_WORKSPACE_ID,
    repoMountId: GIT_MOUNT_ID,
    cloneId: "019b7b30-0280-7c11-8420-b1a5c0de2040",
    executionMode: "ephemeral clone",
  };

  it("says the question was not put, and names why, for an in-place root", async () => {
    const port = countingPort();
    const clock = new ManualClock();
    const reader = readers.open(port.bridge, clock, BRANCH_ROOT);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // `not-checked` and never `no-context`: a workspace with no writable context is a
    // read that ANSWERED, and nothing here answered anything.
    expect(reading.state).toStrictEqual({ kind: "not-checked" });
    expect(reading.refusal?.code).toBe("subject-not-addressable");
    expect(reading.refusal?.detail).toBe(BRANCH_ROOT_UNADDRESSABLE_COPY);
    expect(reading.settlement).toBe(BRANCH_ROOT_UNADDRESSABLE_COPY);
  });

  it("says it for a clone root too, in that root's own words", async () => {
    const port = countingPort();
    const clock = new ManualClock();
    const reader = readers.open(port.bridge, clock, CLONE_ROOT);
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.refusal?.detail).toBe(EPHEMERAL_CLONE_UNADDRESSABLE_COPY);
  });

  it("makes no call and arms no read for a root it cannot ask about", async () => {
    // The rule the arm exists to enforce: sending the workspace id alone would be a
    // request shape no producer accepts, so nothing is sent — and nothing is armed
    // either, because a focus and a reconnect would each buy the same non-answer.
    const port = countingPort();
    const clock = new ManualClock();
    const store = initialisedStore();
    const reader = readers.open(port.bridge, clock, BRANCH_ROOT, store);
    reader.start();
    await settle(clock, reader);
    // The two reasons a gate re-reads without anybody acting. Both reach an addressable
    // root; neither may buy a call here, because the answer would be the same refusal.
    store.markDegraded("subscription-closed");
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    store.applyBatch([
      {
        id: "event-1",
        sessionId: REPOS_SCENARIO.sessionId,
        sequence: 1,
        kind: "workspace.stale",
        occurredAt: "2026-01-01T09:05:01.900Z",
      },
    ]);
    await settle(clock, reader);

    expect(port.calls()).toBe(0);
    expect(reader.performCount).toBe(0);
  });

  it("negative control: the one root the request HAS a key for is read as usual", async () => {
    // Without this, the three cases above would pass against a reader that had simply
    // stopped calling the wire for every subject.
    const port = countingPort();
    const clock = new ManualClock();
    const reader = readers.open(port.bridge, clock, SUBJECT);
    reader.start();
    await settle(clock, reader);

    expect(port.calls()).toBe(1);
    expect(reader.performCount).toBe(1);
    expect(reader.snapshot.state.kind).toBe("prepared");
    expect(reader.snapshot.refusal).toBeUndefined();
  });
});
