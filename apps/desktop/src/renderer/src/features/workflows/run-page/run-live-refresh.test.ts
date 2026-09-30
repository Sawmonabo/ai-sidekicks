// The round the run pane re-reads on when the operator did nothing: the engine advancing a
// phase, a park arming a resume, another window's cancel. Counting the round is the instrument: a
// re-read and a re-render look the same on screen.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_MAX_WAIT_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { WorkflowRunLiveRefresh } from "./run-live-refresh.js";

const SESSION_ID = "session-live-rounds";
const RUN_ON_SCREEN = "019b7a10-0280-7aa1-8100-70100000000a";

const openReadings: WorkflowRunLiveRefresh[] = [];

afterEach(() => {
  for (const reading of openReadings.splice(0)) {
    reading.dispose();
  }
});

function initializedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: 0, entities: [] });
  return sessionStore;
}

function openReading(clock: ManualClock, sessionStore: SessionStore): WorkflowRunLiveRefresh {
  const reading = new WorkflowRunLiveRefresh({
    clock,
    sessionStore,
    workflowRunId: RUN_ON_SCREEN,
  });
  openReadings.push(reading);
  reading.start();
  return reading;
}

/** Spend the coalescing window and let the performer's own promise settle. */
async function settle(clock: ManualClock): Promise<void> {
  clock.advance(REFRESH_MAX_WAIT_MS);
  await Promise.resolve();
  await Promise.resolve();
}

describe("WorkflowRunLiveRefresh — what advances the round", () => {
  it("advances on a `workflow.*` frame the session's own store admitted", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);
    expect(reading.round).toBe(0);

    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.phase_suspended", 1)]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("advances when the session's projection is repaired", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);

    sessionStore.markDegraded("subscription-closed");
    await settle(clock);
    expect(reading.round).toBe(0);

    sessionStore.initialize({ cursor: 0, entities: [] });
    await settle(clock);

    expect(reading.round).toBe(1);
  });
});
