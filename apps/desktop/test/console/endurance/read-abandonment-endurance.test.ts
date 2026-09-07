// Tier: endurance — `Spec-023 §Console Test Tiers`.
//
// A pane that is closed while its read is on the wire pays for nothing after it
// closes, and a console that opens and closes panes all day accumulates nothing from
// having done so. Both claims are about SUSTAINED churn, which is why they are here:
// one abandoned read costs so little that a unit case cannot tell a console that
// stops from one that does not, and the shape this file drives — open, read, close
// mid-read, repeat several hundred times — is exactly the shape a working day has.
//
// WHY THIS RUNS IN THE NODE PROJECT AND OPENS NO ELECTRON WINDOW
//
// The subject is `seats/push-driven-read.ts` over `store/scheduling.ts` over
// `store/read-cancellation.ts` and the daemon call door — a model, a scheduler, a
// read line, and a parse. None of it touches the DOM, and `diff-endurance.test.ts`
// beside this file is the same separation cashed the same way: the claims are
// checkable in milliseconds, deterministically, on any runner, with no bundle to
// build and no window to launch. The DOM half — that a closed pane is gone from the
// tree — is the browser tiers' and is not restated here.
//
// WHAT IS DRIVEN IS THE REAL MECHANISM, top to bottom. A real `PushDrivenRead` over a
// real `RefreshScheduler` on a `ManualClock`, whose read body calls the real
// `callDaemon` against the shipped fixture bridge with the round's own signal — which
// is what a reader in this tree writes. Nothing here reimplements a rule: the tallies
// below observe the mechanism, they do not stand in for it.
//
// THE EVIDENCE THAT NO PARSE RAN is the reply itself. Each held call is released with
// a body the presence schema REFUSES, so a door that had gone on to read it would
// answer `reply-unreadable`. Every answer being `read-abandoned` is therefore
// evidence the parse never ran, rather than evidence it ran and agreed — the
// distinction a "did the value arrive" assertion cannot make.
//
// THREE CLAIMS, and the third is what makes the first two non-vacuous:
//
//   1. NO PROJECTION AFTER ABANDONMENT. Over hundreds of close-mid-read cycles, no
//      model reaches `loaded` and no model reaches `failed`. A surface that has gone
//      renders neither, so paying to decide which one would be paying twice over.
//   2. NOTHING ACCUMULATES. No timer is left armed on the clock, every subscription
//      is released, and the number of listeners the churn leaves behind is zero. A
//      leak here is a leak per pane open, which is the shape that survives a fast
//      tier and kills a long session.
//   3. THE CONTROL. The same churn, with the close held until after the reply, loads
//      every time — so the zero above is a consequence of abandonment and not of a
//      harness that never got as far as reading anything.

import { describe, expect, it } from "vitest";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import { callDaemon } from "../../../src/renderer/src/console/bridge/daemon/daemon-reply.js";
import { bridgeAnswering } from "../../../src/renderer/src/console/bridge/fixture/fixture-bridge.test-support.js";
import { SESSION_ID } from "../../../src/renderer/src/console/bridge/daemon/daemon-reply.test-support.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../src/renderer/src/console/core/index.js";
import { PushDrivenRead } from "../../../src/renderer/src/console/seats/push-driven-read.js";

/**
 * How many open / read / close cycles one claim is measured over.
 *
 * Large enough that a per-cycle leak is unmistakable in the counts below and a
 * per-cycle projection could not hide in rounding, and small enough that the whole
 * file is milliseconds — this tier's cost is the churn, not the fixture.
 */
const CHURN_CYCLES = 400;

/** A reply body the presence schema refuses. Released after every abandonment. */
const UNREADABLE_REPLY = { participants: "not a list" };

/** A reply body the presence schema admits, for the control run. */
const READABLE_REPLY = { participants: [] };

/** What one churn run observed, counted rather than inferred. */
interface ChurnTally {
  /** Every answer the call door gave, in the order the reads took them. */
  readonly doorAnswers: string[];
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

/** Let every queued continuation run. Generous: turn counts are not a contract. */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 32; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * One model over a bridge whose call this run holds, plus the tally it writes to.
 *
 * The read body is what a reader in this tree writes: forward the round's signal to
 * the door, throw on a refusal, project on a reply. Everything the claims measure is
 * counted from inside it.
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
      const reply = await callDaemon(
        underTest.bridge,
        "presence.read",
        { sessionId: SESSION_ID },
        { signal },
      );
      if (reply.status === "refused") {
        tally.doorAnswers.push(reply.refusal.code);
        throw new Error(reply.refusal.code);
      }
      tally.doorAnswers.push("served");
      // THE PROJECTION. Trivial arithmetic standing for the real thing — a roster
      // built, a diff flattened, a timeline folded — because what is under test is
      // whether it runs at all, not what it costs when it does.
      tally.projections += 1;
      return reply.value.participants.length;
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
    // The whole subject of this file: the person left while the daemon was still
    // composing its answer.
    subject.model.dispose();
    call.release(UNREADABLE_REPLY);
    await drainMicrotasks();
  } else {
    call.release(READABLE_REPLY);
    await drainMicrotasks();
    subject.model.dispose();
  }

  await drainMicrotasks();
  subject.releaseSubscription();
}

/** A tally that has counted nothing yet. */
function emptyTally(): ChurnTally {
  return { doorAnswers: [], projections: 0, settlements: 0 };
}

describe("read abandonment under churn — a closed pane pays for nothing", () => {
  it("projects nothing across hundreds of close-mid-read cycles", async () => {
    const clock = new ManualClock(0);
    const tally = emptyTally();

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      await runOneCycle(clock, tally, true);
    }

    expect(tally.projections).toBe(0);
    // Every read reached the door and every one of them was answered by the
    // departure rather than by a parse. A single `reply-unreadable` here would mean
    // a reply was read after its owner had gone.
    expect(tally.doorAnswers).toHaveLength(CHURN_CYCLES);
    expect(new Set(tally.doorAnswers)).toStrictEqual(new Set(["read-abandoned"]));
    // No model reached a rendering state, `failed` included: an abandoned read has
    // no failure to report and no surface left to report it to.
    expect(tally.settlements).toBe(0);
  });

  it("leaves no timer armed and no subscription held", async () => {
    const clock = new ManualClock(0);
    const tally = emptyTally();

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      await runOneCycle(clock, tally, true);
    }

    // `releaseSubscription` asserted the subscription count per cycle; this is the
    // other accumulation, and the one a disposed scheduler would leak: an armed
    // re-read behind a model nothing holds.
    expect(clock.pendingCount).toBe(0);
  });

  it("control: the same churn loads every time when the close waits for the reply", async () => {
    const clock = new ManualClock(0);
    const tally = emptyTally();

    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      await runOneCycle(clock, tally, false);
    }

    // Same models, same door, same fixture, same number of cycles — the one thing
    // that moved is when the pane closed. Without this the zeroes above would be
    // satisfied by a harness whose reads never reached the wire.
    expect(tally.projections).toBe(CHURN_CYCLES);
    expect(new Set(tally.doorAnswers)).toStrictEqual(new Set(["served"]));
    expect(tally.settlements).toBe(CHURN_CYCLES);
    expect(clock.pendingCount).toBe(0);
  });
});
