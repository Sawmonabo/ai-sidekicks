// The provider-import progress feed: one frame per declared tick, and not before.
//
// THE SUBJECT IS THE SCHEDULE, not the frames. The scenario declares what the import
// reports and when; this port is what holds each reading until the frozen clock has
// reached its tick. A drain that ran the array straight through delivered all three
// readings on one turn — React batched the renders and the fixture painted only the
// terminal `complete` frame — so the running states and a mid-import cancellation, the
// two things this scenario is the test instrument for, were reachable from nowhere.
//
// EVERY CASE DRIVES THE REAL PORT OVER THE SHIPPED SCENARIO. A stub would answer
// whatever it was told to; what these assert is that the scenario the console actually
// ships reaches each frame in turn, and stops where a consumer stops it.

import { describe, expect, it } from "vitest";

import { createFixture, type FixtureUnderTest } from "../call-plane/bridge.test-support.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import {
  BRING_YOUR_HISTORY_SCENARIO,
  PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES,
} from "../../scenario/bring-your-history.js";
import type { GrowthImportProgress } from "../../growth-values/index.js";
import type { GrowthStream } from "../../growth-port/growth-outcome.js";

/** The provider this scenario holds a readable transcript for. */
const IMPORTABLE_PROVIDER = "claude";

/** What every frame the script declares looks like once released, in order. */
const EVERY_PROGRESS_READING: readonly GrowthImportProgress[] =
  PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES.map((frame) => frame.progress);

/**
 * Begin the scripted import and open its progress feed, through the real port.
 *
 * The identifier comes from the BEGIN call rather than from a literal, so a case that
 * subscribed to an import the opening call never minted would fail here instead of
 * asserting against a feed nobody could have opened.
 */
async function openImportProgress(
  fixture: FixtureUnderTest,
): Promise<GrowthStream<GrowthImportProgress>> {
  const begun = await fixture.bridge.growth.providerSessionImportBegin({
    providerName: IMPORTABLE_PROVIDER,
    sourceRef: "~/.claude/threads/one.jsonl",
  });
  if (begun.status !== "served") {
    throw new Error("the scenario did not begin an import");
  }
  const opened = await fixture.bridge.growth.providerSessionImportSubscribe({
    importId: begun.value.importId,
  });
  if (opened.status !== "served") {
    throw new Error("the scenario did not open a progress feed for the import it began");
  }
  return opened.value;
}

/** What one consumer has been handed so far, and whether its walk has finished. */
interface DrainedFeed<TValue> {
  readonly received: readonly TValue[];
  readonly hasFinished: () => boolean;
}

/**
 * Drain a feed into an array as its frames arrive, without blocking the case.
 *
 * A live consumer rather than a collected promise, because what is under test is WHEN
 * each frame arrives: awaiting the whole walk would answer only what it delivered in
 * total, which a drain with no pacing at all also answers correctly.
 */
function drain<TValue>(stream: GrowthStream<TValue>): DrainedFeed<TValue> {
  const received: TValue[] = [];
  let finished = false;
  void (async () => {
    for await (const value of stream.events) {
      received.push(value);
    }
    finished = true;
  })();
  return { received, hasFinished: () => finished };
}

describe("the scripted import's progress frames", () => {
  it("declares three readings on strictly rising ticks", () => {
    // The vacuity guard for every case below: a one-frame script would make "nothing
    // before its due" true of nothing, and an unordered one would make the walk's own
    // prefix rule meaningless.
    expect(PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES).toHaveLength(3);
    const ticks = PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES.map((frame) => frame.atMs);
    expect(ticks).toStrictEqual([...ticks].sort((left, right) => left - right));
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("releases each frame only once the clock has reached its tick", async () => {
    const fixture = createFixture(BRING_YOUR_HISTORY_SCENARIO);
    const feed = drain(await openImportProgress(fixture));
    await crossMacrotaskBoundary();

    // The first tick is zero, so that reading is due the moment the feed opens. The
    // two behind it are not — and a walk that drained the script would hold all three.
    expect(feed.received).toStrictEqual(EVERY_PROGRESS_READING.slice(0, 1));

    for (
      let position = 1;
      position < PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES.length;
      position += 1
    ) {
      const previous = PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES[position - 1]?.atMs ?? 0;
      const current = PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES[position]?.atMs ?? 0;
      // One tick short of this frame's own, which is where "not before its due" is
      // measured: the clock has moved and this reading is still not owed.
      fixture.engine.advance(current - previous - 1);
      await crossMacrotaskBoundary();
      expect(feed.received).toStrictEqual(EVERY_PROGRESS_READING.slice(0, position));

      fixture.engine.advance(1);
      await crossMacrotaskBoundary();
      expect(feed.received).toStrictEqual(EVERY_PROGRESS_READING.slice(0, position + 1));
    }

    // And the producer stops of its own accord once the script is spent, which is what
    // the panel reads as an import that ended rather than one still running.
    expect(feed.hasFinished()).toBe(true);
  });

  it("delivers no later frame once the subscription is closed", async () => {
    const fixture = createFixture(BRING_YOUR_HISTORY_SCENARIO);
    const stream = await openImportProgress(fixture);
    const feed = drain(stream);
    await crossMacrotaskBoundary();
    expect(feed.received).toStrictEqual(EVERY_PROGRESS_READING.slice(0, 1));

    stream.close();
    await crossMacrotaskBoundary();
    // Closed means ended, not merely quiet: a walk still parked on the next tick is a
    // producer with no reader, which is the RAM the console's budgets are measured
    // against and, on the live wire, a subscription the daemon still holds.
    expect(feed.hasFinished()).toBe(true);

    // The rest of the script falls due and reaches nobody.
    fixture.engine.runToCompletion();
    fixture.engine.advance(PROVIDER_SESSION_IMPORT_PROGRESS_FRAMES.at(-1)?.atMs ?? 0);
    await crossMacrotaskBoundary();
    expect(feed.received).toStrictEqual(EVERY_PROGRESS_READING.slice(0, 1));
  });
});
