// What refreshes each of the agent console's reads.
//
// One claim, checked on the two shapes the factories carry: a read with a push
// signal re-reads when the session stream admits a kind it watches and never when
// it admits one it does not, and a read whose subscription is a stated no-op
// re-reads never. Both are counted on the read itself rather than inferred from a
// rendered row, because a surface can show a stale figure for either reason.
//
// The lifetime half — who holds these reads and what disposes them — is
// `agent-console-model.test.ts`.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../bridge/index.js";
import { ManualClock, REFRESH_MAX_WAIT_MS } from "../core/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../store/index.js";
import { createChildRunLinkage, createDriverCatalog } from "./agent-console-reads.js";

const PARENT_RUN_ID = "run-7";

/** A real fixture bridge that scripts no reply, so every read settles as refused. */
function unscriptedBridge(id: string): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario(id), {});
}

/** An initialised store, so an appended event is admitted rather than buffered. */
function initialisedStore(sessionId: string): SessionStore {
  const sessionStore = new SessionStore({ sessionId });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

/** One admitted event of the given kind, numbered so the cursor moves. */
function eventOfKind(
  sessionStore: SessionStore,
  kind: ConsoleSessionEvent["kind"],
  sequence: number,
): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: sessionStore.sessionId,
    sequence,
    kind,
    occurredAt: "2026-01-01T10:06:00.000Z",
    payload: {},
  };
}

/** A started linkage read over a store this case owns, on frozen time. */
function startedLinkage(
  sessionStore: SessionStore,
  clock: ManualClock,
): ReturnType<typeof createChildRunLinkage> {
  const read = createChildRunLinkage(
    unscriptedBridge("agent-linkage-signal"),
    sessionStore,
    PARENT_RUN_ID,
    clock,
  );
  read.start();
  return read;
}

/** Let every refresh armed inside the coalescing window fall due. */
async function settleReads(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(REFRESH_MAX_WAIT_MS);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

describe("the agent console's models — what re-reads one run's child links", () => {
  it("re-reads once when a run is queued, and once when a create is refused", async () => {
    const sessionStore = initialisedStore("session-signal");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    await settleReads(clock);
    expect(read.readCount).toBe(afterFirstRead + 1);

    sessionStore.apply(eventOfKind(sessionStore, "orchestration.rejected", 2));
    await settleReads(clock);
    expect(read.readCount).toBe(afterFirstRead + 2);
  });

  it("coalesces a burst of queued runs into one read", async () => {
    const sessionStore = initialisedStore("session-burst");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 2));
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 3));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead + 1);
  });

  it("re-reads nothing for a kind the linkage does not watch", async () => {
    const sessionStore = initialisedStore("session-unwatched");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "assistant.message", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead);
  });

  it("re-reads nothing once the read has been disposed", async () => {
    const sessionStore = initialisedStore("session-disposed");
    const clock = new ManualClock();
    const read = startedLinkage(sessionStore, clock);
    await settleReads(clock);
    const afterFirstRead = read.readCount;

    read.dispose();
    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    await settleReads(clock);

    expect(read.readCount).toBe(afterFirstRead);
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: the read whose subscribe is a stated no-op re-reads zero times", async () => {
    // The driver catalog is the shape the linkage had — no signal at all — and it
    // sits beside it in this module. Without this the cases above would pass over
    // an instrument that counted something other than a re-read.
    const sessionStore = initialisedStore("session-no-signal");
    const clock = new ManualClock();
    const catalog = createDriverCatalog(unscriptedBridge("agent-catalog-signal"), clock);
    catalog.start();
    await settleReads(clock);
    const afterFirstRead = catalog.readCount;

    sessionStore.apply(eventOfKind(sessionStore, "run.queued", 1));
    await settleReads(clock);

    expect(afterFirstRead).toBeGreaterThan(0);
    expect(catalog.readCount).toBe(afterFirstRead);
    catalog.dispose();
  });
});
