// The round the run pane re-reads on when nobody at this keyboard did anything.
//
// The class beside `run-snapshot.ts` counts the OTHER half of that read's round: the
// engine advancing a phase, a park arming a resume, another window's cancel. Every
// case here holds the operator still and varies what arrives from outside — which is
// exactly the half `run-snapshot.rounds.test.tsx` cannot reach, since it drives the
// round in by hand.
//
// COUNTING THE ROUND IS THE INSTRUMENT, because a re-read and a re-render are
// indistinguishable from a rendered state: a reading that advanced on every store
// transition would look identical on screen while asking the daemon over and over.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock, REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { WorkflowRunLiveRounds } from "./run-live-rounds.js";

const SESSION_ID = "session-live-rounds";

/** Every reading a case opens, disposed whatever the case did. */
const openReadings: WorkflowRunLiveRounds[] = [];

afterEach(() => {
  for (const reading of openReadings.splice(0)) {
    reading.dispose();
  }
});

/** A store the trigger set will read transitions off — initialised, as it requires. */
function initialisedStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return sessionStore;
}

function openReading(
  clock: ManualClock,
  sessionStore: SessionStore | undefined,
): WorkflowRunLiveRounds {
  const reading = new WorkflowRunLiveRounds({ clock, sessionStore });
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

describe("WorkflowRunLiveRounds — what advances the round", () => {
  it("advances on a `workflow.*` frame the session's own store admitted", async () => {
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reading = openReading(clock, sessionStore);
    expect(reading.round).toBe(0);

    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.phase_suspended", 1)]);
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("advances on every category of the taxonomy, not only the lifecycle one", async () => {
    // The declaration is the whole taxonomy on purpose: a run read projects the run's
    // status, every phase's state and every live park, so there is no category whose
    // frames cannot move something the pane draws.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reading = openReading(clock, sessionStore);

    const oneOfEachCategory = [
      "workflow.cancelled",
      "workflow.phase_resumed",
      "workflow.parallel_join_cancellation",
      "workflow.channel_created_for_phase",
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
    // The reconnect reason. A daemon that dropped and came back while this window
    // stayed focused left the run on screen as old as the moment it went away.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reading = openReading(clock, sessionStore);

    sessionStore.markDegraded("subscription-closed");
    await settle(clock);
    expect(reading.round).toBe(0);

    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("advances when the window is focused again", async () => {
    const clock = new ManualClock();
    const reading = openReading(clock, initialisedStore());

    window.dispatchEvent(new Event("focus"));
    await settle(clock);

    expect(reading.round).toBe(1);
  });

  it("collapses a burst of frames into ONE advance", async () => {
    // A fan-out completing four phases at once is one thing to re-read for, and the
    // scheduler is what decides that — this reading arms no window of its own.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
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

describe("WorkflowRunLiveRounds — what does not advance it", () => {
  it("negative control: a frame outside the workflow taxonomy advances nothing", async () => {
    // Without this every case above would pass against a reading that advanced on any
    // transition at all, which is a re-read cadence keyed to session traffic.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
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
    openReading(clock, initialisedStore());

    clock.advance(REFRESH_DEBOUNCE_MS * 1000);
    await Promise.resolve();

    expect(clock.pendingCount).toBe(0);
  });

  it("observes nothing at all with no session behind the pane", async () => {
    // The deck opens a run pane from a keybinding before a session is chosen. With no
    // store there is no timeline to watch, and a reading that invented one would be
    // watching a session nobody named.
    const clock = new ManualClock();
    const reading = openReading(clock, undefined);

    window.dispatchEvent(new Event("focus"));
    await settle(clock);

    expect(reading.round).toBe(0);
    expect(reading.isReadingFor(undefined)).toBe(true);
  });
});

describe("WorkflowRunLiveRounds — teardown", () => {
  it("advances on no later frame and no later focus once disposed", async () => {
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reading = openReading(clock, sessionStore);
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.started", 1)]);
    await settle(clock);
    const roundBeforeDispose = reading.round;
    expect(roundBeforeDispose).toBe(1);

    reading.dispose();
    sessionStore.applyBatch([eventOfKind(SESSION_ID, "workflow.completed", 2)]);
    window.dispatchEvent(new Event("focus"));
    sessionStore.markDegraded("subscription-closed");
    sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    await settle(clock);

    expect(reading.round).toBe(roundBeforeDispose);
    expect(reading.isDisposed).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  it("publishes each advance to its subscribers and stops on unsubscribe", async () => {
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
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
    // The round itself kept moving — what stopped was this subscriber, not the count.
    expect(reading.round).toBe(2);
  });

  it("reports the store it watches, so a projection rebuilt for it is caught", () => {
    // The one axis the resource seam's key cannot carry: a store replaced across a
    // reconnect keeps the whole address while being another object.
    const clock = new ManualClock();
    const sessionStore = initialisedStore();
    const reading = openReading(clock, sessionStore);

    expect(reading.isReadingFor(sessionStore)).toBe(true);
    expect(reading.isReadingFor(initialisedStore())).toBe(false);
  });
});
