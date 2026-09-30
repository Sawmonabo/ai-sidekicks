// Supersession a caller cannot decline: a scheduler built with only the usual members still
// hands its performer a round, so no read is unsupersedable and unabandonable.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../clock.js";
import type { ReadRound } from "./read-scope.js";
import { RefreshScheduler } from "./refresh-scheduler.js";
import { settleMicrotasks } from "@test/helpers/session-store-fixtures.js";

/** A local debounce: the round is under test, not the shipped interval. */
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
    // Control: the round is live before `dispose()`, so the assertion after is about disposal.
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

    // Nothing fires after dispose, so no live round exists for anyone to supersede.
    expect(rounds).toStrictEqual([]);
  });
});
