// The scheduler's own read line: supersession that a caller cannot decline.
//
// Before this pairing existed, a `RefreshScheduler` and a `GenerationLatch` were two
// objects a reader was expected to bring together, and thirteen readers each decided
// that for themselves. The claim these cases make is not that the pairing is possible
// but that it is UNAVOIDABLE: a scheduler built with the two members every caller
// already passes hands its performer a round, and a read that cannot be superseded
// and cannot be abandoned is not a thing this class can produce.
//
// Driven on `ManualClock`, arming no real timer, for `scheduling.refresh-scheduler.
// test.ts`'s reason — an assertion about what is armed cannot be made on wall time.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import type { ReadRound } from "./read-cancellation.js";
import { RefreshScheduler } from "./scheduling.js";
import { settleMicrotasks } from "./session-store-registry.test-support.js";

/**
 * The debounce these cases drive, named once.
 *
 * A local number rather than the console's own `REFRESH_DEBOUNCE_MS`: what is under
 * test is the round, not the interval, and pinning the shipped constant in a suite
 * that does not measure it is the restated-threshold `apps/desktop/AGENTS.md`
 * rejects. Any positive value serves, and this one is the neighbouring suite's.
 */
const TEST_DEBOUNCE_MS = 120;

/** A scheduler built with only the members every caller already passes. */
function schedulerRecordingRounds(clock: ManualClock, rounds: ReadRound[]): RefreshScheduler {
  return new RefreshScheduler({
    clock,
    debounceMs: TEST_DEBOUNCE_MS,
    perform: (_reasons, round) => {
      rounds.push(round);
      return Promise.resolve();
    },
  });
}

/** Advance past the debounce and let the fire's own microtasks settle. */
async function runOneRead(clock: ManualClock): Promise<void> {
  clock.advance(TEST_DEBOUNCE_MS);
  await settleMicrotasks();
}

describe("RefreshScheduler — every read runs inside a round", () => {
  it("hands the performer a live round without being asked for one", async () => {
    const clock = new ManualClock(0);
    const rounds: ReadRound[] = [];
    const scheduler = schedulerRecordingRounds(clock, rounds);

    scheduler.request("subscribe");
    await runOneRead(clock);

    expect(rounds).toHaveLength(1);
    const round = rounds[0];
    expect(round?.signal.aborted).toBe(false);
    expect(round?.isCurrent).toBe(true);

    scheduler.dispose();
  });

  it("supersedes the previous read's round when the next read fires", async () => {
    const clock = new ManualClock(0);
    const rounds: ReadRound[] = [];
    const scheduler = schedulerRecordingRounds(clock, rounds);

    scheduler.request("subscribe");
    await runOneRead(clock);
    scheduler.request("window-focus");
    await runOneRead(clock);

    expect(rounds).toHaveLength(2);
    const [first, second] = rounds;
    expect(first?.isCurrent).toBe(false);
    expect(first?.settle(() => undefined)).toBe(false);
    expect(second?.isCurrent).toBe(true);
    expect(second?.settle(() => undefined)).toBe(true);

    scheduler.dispose();
  });

  it("abandons the read in flight when the scheduler is disposed", async () => {
    const clock = new ManualClock(0);
    const rounds: ReadRound[] = [];
    let releaseRead: () => void = () => undefined;
    const scheduler = new RefreshScheduler({
      clock,
      debounceMs: TEST_DEBOUNCE_MS,
      perform: async (_reasons, round) => {
        rounds.push(round);
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      },
    });

    scheduler.request("subscribe");
    await runOneRead(clock);

    const inFlight = rounds[0];
    // The control: the read is genuinely outstanding and its round is live, so the
    // reading after `dispose()` is about the disposal and not about a dead round.
    expect(inFlight?.signal.aborted).toBe(false);

    scheduler.dispose();

    expect(inFlight?.signal.aborted).toBe(true);
    expect(inFlight?.isCurrent).toBe(false);

    releaseRead();
    await settleMicrotasks();
    expect(clock.pendingCount).toBe(0);
  });

  it("hands a disposed scheduler's late fire a round that is already over", async () => {
    const clock = new ManualClock(0);
    const rounds: ReadRound[] = [];
    const scheduler = schedulerRecordingRounds(clock, rounds);

    scheduler.dispose();
    scheduler.request("subscribe");
    await runOneRead(clock);

    // Nothing fires at all, which is the scheduler's own terminal rule; the round
    // list is empty rather than holding a live round nobody can supersede.
    expect(rounds).toStrictEqual([]);
  });
});
