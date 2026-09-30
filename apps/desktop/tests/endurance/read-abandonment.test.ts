// Tier: endurance.
//
// A pane closed while its read is on the wire pays for nothing after it closes, and a console
// that opens and closes panes all day accumulates nothing. Both claims are about sustained
// churn: one abandoned read costs too little for a unit case to tell, so this drives open,
// read, close mid-read, several hundred times.
//
// It runs in the Node project and opens no Electron window. The subject is
// `store/reads/push-driven-read.ts` over `lib/reads/refresh-scheduler.ts`,
// `lib/reads/read-scope.ts` and `callDaemon`, none of which touches the DOM, so the claims are
// checkable in milliseconds on any runner, as in `diff-row-index.test.ts` beside it. That a
// closed pane is gone from the tree belongs to the browser tiers.
//
// The real mechanism is driven top to bottom: a `PushDrivenRead` over a `RefreshScheduler` on a
// `ManualClock`, whose read body calls the real `callDaemon` against the fixture bridge with the
// round's own signal. The tallies observe it; they do not stand in for it.
//
// The evidence that no parse ran is the reply itself. Each held call is released with a body the
// presence schema refuses, so a call that read it would answer `reply-unreadable`; every answer
// being `read-abandoned` shows the parse never ran, which a "did the value arrive" assertion
// cannot.
//
// Three claims, the third making the first two non-vacuous:
//   1. No projection after abandonment: over hundreds of close-mid-read cycles no model reaches
//      `loaded` or `failed`, since a gone view renders neither.
//   2. Nothing accumulates: no timer stays armed on the clock, every subscription is released
//      and the churn leaves zero listeners. A leak here is a leak per pane open.
//   3. The control: the same churn with the close held until after the reply loads every time,
//      so the zeros above come from abandonment and not from a harness that never read.

import { describe, expect, it } from "vitest";
import type { Unsubscribe } from "@shared/preload-api.js";

import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { bridgeAnswering } from "../helpers/fixture-bridge.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";
import { PushDrivenRead } from "@renderer/store/reads/push-driven-read.js";

/**
 * How many open / read / close cycles one claim is measured over.
 *
 * Large enough that a per-cycle leak is unmistakable and small enough that the file takes a few
 * seconds, nearly all of it the two real timer boundaries each cycle waits on. That is the price
 * of `crossMacrotaskBoundary` over a counted microtask loop, whose count would be tuned against
 * whatever settlement chain sits under it today.
 */
const CHURN_CYCLES = 400;

/** A reply body the presence schema refuses. Released after every abandonment. */
const UNREADABLE_REPLY = { devices: "not a list" };

/** A reply body the presence schema admits, for the control run. */
const READABLE_REPLY = { devices: [] };

/** What one churn run observed, counted rather than inferred. */
interface ChurnTally {
  /** Every answer `callDaemon` gave, in the order the reads took them. */
  readonly callAnswers: string[];
  /** How many times a read body projected a reply into a value. */
  projections: number;
  /** How many times a model reached a rendering state. */
  settlements: number;
}

/** A call held open, and the release that answers it. */
interface HeldCall {
  readonly answered: Promise<unknown>;
  readonly release: (body: unknown) => void;
}

/**
 * One model over a bridge whose call this run holds, plus the tally it writes to.
 *
 * The read body is what a reader in this tree writes: forward the round's signal to
 * `callDaemon`, throw on a refusal, project on a reply.
 */
function openChurnSubject(
  clock: ManualClock,
  tally: ChurnTally,
): {
  readonly model: PushDrivenRead<number>;
  readonly held: Promise<HeldCall>;
  readonly releaseSubscription: () => void;
} {
  let handOverCall: (call: HeldCall) => void = () => undefined;
  const held = new Promise<HeldCall>((resolve) => {
    handOverCall = resolve;
  });
  const underTest = bridgeAnswering(
    async () =>
      await new Promise<unknown>((answer) => {
        handOverCall({
          answered: Promise.resolve(),
          release: (body: unknown) => {
            answer(body);
          },
        });
      }),
  );

  let subscriptionsHeld = 0;
  const model = new PushDrivenRead<number>({
    clock,
    origin: "churn.read",
    subscribe: (): Unsubscribe => {
      subscriptionsHeld += 1;
      return () => {
        subscriptionsHeld -= 1;
      };
    },
    read: async (signal) => {
      const reply = await callDaemon(underTest.bridge, "presence.read", {}, { signal });
      if (reply.status === "refused") {
        tally.callAnswers.push(reply.refusal.code);
        throw new Error(reply.refusal.code);
      }
      tally.callAnswers.push("served");
      // Trivial arithmetic standing for a real projection; what is under test is whether it
      // runs at all, not what it costs.
      tally.projections += 1;
      return reply.value.devices.length;
    },
  });

  return {
    model,
    held,
    releaseSubscription: () => {
      expect(subscriptionsHeld).toBe(0);
    },
  };
}

/** Drive one cycle: open, reach the wire, then close before or after the reply. */
async function runOneCycle(
  clock: ManualClock,
  tally: ChurnTally,
  closeBeforeTheReply: boolean,
): Promise<void> {
  const subject = openChurnSubject(clock, tally);
  subject.model.onChange(() => {
    tally.settlements += 1;
  });
  subject.model.start();
  clock.advance(REFRESH_DEBOUNCE_MS);
  const call = await subject.held;

  if (closeBeforeTheReply) {
    // The person left while the daemon was still composing its answer.
    subject.model.dispose();
    call.release(UNREADABLE_REPLY);
    await crossMacrotaskBoundary();
  } else {
    call.release(READABLE_REPLY);
    await crossMacrotaskBoundary();
    subject.model.dispose();
  }

  await crossMacrotaskBoundary();
  subject.releaseSubscription();
}

/** A tally that has counted nothing yet. */
function emptyTally(): ChurnTally {
  return { callAnswers: [], projections: 0, settlements: 0 };
}

describe("read abandonment under churn — a closed pane pays for nothing", () => {
  it("projects nothing across hundreds of close-mid-read cycles", async () => {
    const clock = new ManualClock(0);
    const tally = emptyTally();

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      await runOneCycle(clock, tally, true);
    }

    expect(tally.projections).toBe(0);
    // Every read reached `callDaemon` and was answered by the departure, not a parse. A single
    // `reply-unreadable` would mean a reply was read after its owner had gone.
    expect(tally.callAnswers).toHaveLength(CHURN_CYCLES);
    expect(new Set(tally.callAnswers)).toStrictEqual(new Set(["read-abandoned"]));
    // No model reached a rendering state, `failed` included: an abandoned read has no failure
    // to report and no view left to report it to.
    expect(tally.settlements).toBe(0);
  });

  it("leaves no timer armed and no subscription held", async () => {
    const clock = new ManualClock(0);
    const tally = emptyTally();

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      await runOneCycle(clock, tally, true);
    }

    // `releaseSubscription` asserted the subscription count per cycle; this is the other
    // accumulation, an armed re-read behind a model nothing holds.
    expect(clock.pendingCount).toBe(0);
  });

  it("control: the same churn loads every time when the close waits for the reply", async () => {
    const clock = new ManualClock(0);
    const tally = emptyTally();

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      await runOneCycle(clock, tally, false);
    }

    // Only the close time moved. Without this the zeroes above would be satisfied by a harness
    // whose reads never reached the wire.
    expect(tally.projections).toBe(CHURN_CYCLES);
    expect(new Set(tally.callAnswers)).toStrictEqual(new Set(["served"]));
    expect(tally.settlements).toBe(CHURN_CYCLES);
    expect(clock.pendingCount).toBe(0);
  });
});
