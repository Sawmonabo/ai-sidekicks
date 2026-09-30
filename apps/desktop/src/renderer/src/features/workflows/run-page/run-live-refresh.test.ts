// The round the run pane re-reads on when the operator did nothing: the engine advancing a
// phase, a park arming a resume, another window's cancel. The half driven by hand is
// `hooks/useWorkflowRunSnapshot.refresh.test.ts`. Counting the round is the instrument: a re-read
// and a re-render look the same on screen.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "@renderer/lib/reads/refresh-caps.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { eventOfKind } from "@test/helpers/session-events.js";
import { WorkflowRunLiveRefresh } from "./run-live-refresh.js";

const SESSION_ID = "session-live-rounds";
const RUN_ON_SCREEN = "019b7a10-0280-7aa1-8100-70100000000a";
const RUN_ELSEWHERE = "019b7a10-0280-7aa1-8100-70100000000b";

function frameForRun(kind: string, sequence: number, workflowRunId: string): ProjectedSessionEvent {
  return eventOfKind(SESSION_ID, kind, sequence, { workflowRunId });
}

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

/**
 * A wrapper, not a defaulted parameter: a pane may name no run, and `undefined` against a
 * defaulted parameter would silently take the default `RUN_ON_SCREEN`.
 */
interface PaneUnderReading {
  readonly workflowRunId: string | undefined;
}

function openReading(
  clock: ManualClock,
  sessionStore: SessionStore | undefined,
  pane: PaneUnderReading = { workflowRunId: RUN_ON_SCREEN },
): WorkflowRunLiveRefresh {
  const reading = new WorkflowRunLiveRefresh({
    clock,
    sessionStore,
    workflowRunId: pane.workflowRunId,
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

  it("advances on every category of the taxonomy, not only the lifecycle one", async () => {
    // The declaration is the whole taxonomy: a run read projects status, phases and parks, so
    // no category's frames are irrelevant to the pane.
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);

    const oneOfEachCategory = [
      "workflow.canceled",
      "workflow.phase_resumed",
      "workflow.parallel_join_cancellation",
      "workflow.gate_resolved",
    ];
    let advancedFor = 0;
    for (const [offset, kind] of oneOfEachCategory.entries()) {
      const before = reading.round;
      sessionStore.applyBatch([eventOfKind(SESSION_ID, kind, offset + 1)]);
      await settle(clock);
      if (reading.round > before) {
        advancedFor += 1;
      }
    }

    expect(advancedFor).toBe(oneOfEachCategory.length);
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

  it("advances when the window is focused again", async () => {
    const clock = new ManualClock();
    const reading = openReading(clock, initializedStore());

    window.dispatchEvent(new Event("focus"));
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("collapses a burst of frames into ONE advance", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);

    sessionStore.applyBatch([
      eventOfKind(SESSION_ID, "workflow.phase_completed", 1),
      eventOfKind(SESSION_ID, "workflow.phase_started", 2),
      eventOfKind(SESSION_ID, "workflow.phase_progressed", 3),
      eventOfKind(SESSION_ID, "workflow.phase_completed", 4),
    ]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });
});

describe("WorkflowRunLiveRefresh — which run the frame is about", () => {
  it("advances on a frame whose payload names the run on screen", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore, { workflowRunId: RUN_ON_SCREEN });

    sessionStore.applyBatch([frameForRun("workflow.phase_progressed", 1, RUN_ON_SCREEN)]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("advances on nothing for a frame that names another run", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore, { workflowRunId: RUN_ON_SCREEN });

    sessionStore.applyBatch([
      frameForRun("workflow.phase_progressed", 1, RUN_ELSEWHERE),
      frameForRun("workflow.phase_completed", 2, RUN_ELSEWHERE),
      frameForRun("workflow.canceled", 3, RUN_ELSEWHERE),
    ]);
    await settle(clock);

    expect(reading.round).toBe(0);
  });

  it("negative control: the same three frames advance the reading addressed at THAT run", async () => {
    // Guards the case above against a reading that refuses every frame carrying a payload.
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore, { workflowRunId: RUN_ELSEWHERE });

    sessionStore.applyBatch([
      frameForRun("workflow.phase_progressed", 1, RUN_ELSEWHERE),
      frameForRun("workflow.phase_completed", 2, RUN_ELSEWHERE),
      frameForRun("workflow.canceled", 3, RUN_ELSEWHERE),
    ]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("collapses a burst naming both runs into the one advance this run owes", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore, { workflowRunId: RUN_ON_SCREEN });

    sessionStore.applyBatch([
      frameForRun("workflow.phase_started", 1, RUN_ELSEWHERE),
      frameForRun("workflow.phase_started", 2, RUN_ON_SCREEN),
      frameForRun("workflow.phase_progressed", 3, RUN_ELSEWHERE),
    ]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("advances on a frame that names no run", async () => {
    // `workflow.phase_progressed` has no registered payload, so its frame may not carry the run
    // at all; refusing it would leave a pane stale rather than merely over-read.
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore, { workflowRunId: RUN_ON_SCREEN });

    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.phase_progressed", 1)]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("refuses a named frame on a pane that names no run of its own", async () => {
    // A run pane can open from a keybinding before an entity is chosen; it reads nothing.
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore, { workflowRunId: undefined });

    sessionStore.applyBatch([frameForRun("workflow.phase_progressed", 1, RUN_ON_SCREEN)]);
    await settle(clock);

    expect(reading.round).toBe(0);
  });
});

describe("WorkflowRunLiveRefresh — what does not advance it", () => {
  it("negative control: a frame outside the workflow taxonomy advances nothing", async () => {
    // Guards every case above against a reading that advanced on any transition at all.
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);

    sessionStore.applyBatch([
      eventOfKind(SESSION_ID, "run.queued", 1),
      eventOfKind(SESSION_ID, "workspace.stale", 2),
      eventOfKind(SESSION_ID, "assistant.message", 3),
    ]);
    await settle(clock);

    expect(reading.round).toBe(0);
  });

  it("arms no timer of its own, so a long silence buys no read", async () => {
    const clock = new ManualClock();
    openReading(clock, initializedStore());

    clock.advance(REFRESH_DEBOUNCE_MS * 1000);
    await Promise.resolve();

    expect(clock.pendingCount).toBe(0);
  });

  it("observes nothing at all with no session behind the pane", async () => {
    const clock = new ManualClock();
    const reading = openReading(clock, undefined);

    window.dispatchEvent(new Event("focus"));
    await settle(clock);

    expect(reading.round).toBe(0);
    expect(reading.isReadingFor(undefined)).toBe(true);
  });
});

describe("WorkflowRunLiveRefresh — teardown", () => {
  it("advances on no later frame and no later focus once disposed", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.started", 1)]);
    await settle(clock);
    const roundBeforeDispose = reading.round;
    expect(roundBeforeDispose).toBe(1);

    reading.dispose();
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.completed", 2)]);
    window.dispatchEvent(new Event("focus"));
    sessionStore.markDegraded("subscription-closed");
    sessionStore.initialize({ cursor: 0, entities: [] });
    await settle(clock);

    expect(reading.round).toBe(roundBeforeDispose);
    expect(reading.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  it("publishes each advance to its subscribers and stops on unsubscribe", async () => {
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);
    const published: number[] = [];
    const unsubscribe = reading.subscribe((round) => {
      published.push(round);
    });

    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.phase_admitted", 1)]);
    await settle(clock);
    unsubscribe();
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.phase_started", 2)]);
    await settle(clock);

    expect(published).toStrictEqual([1]);
    // The round kept moving; only this subscriber stopped.
    expect(reading.round).toBe(2);
  });

  it("reports the store it watches, so a projection rebuilt for it is caught", () => {
    // A store replaced across a reconnect keeps the whole resource key but is another object.
    const clock = new ManualClock();
    const sessionStore = initializedStore();
    const reading = openReading(clock, sessionStore);

    expect(reading.isReadingFor(sessionStore)).toBe(true);
    expect(reading.isReadingFor(initializedStore())).toBe(false);
  });
});
