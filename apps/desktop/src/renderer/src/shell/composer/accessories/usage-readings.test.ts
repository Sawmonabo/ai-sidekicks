// The usage fold, asserted where it decides something.
//
// Two claims are worth a unit here, because each one is a place the console could
// quietly start asserting a figure the daemon never sent: a context payload missing
// half of the count pair yields NO reading rather than a 0% one, and a compaction
// boundary is the ADDRESSED run's or it is nobody's.
//
// The rate-limit fold that used to be asserted here moved with the fold itself, to
// `console/bridge/provider-account-quota.test.ts` — its readings come off the account
// plane and never off a session timeline, so a case that built one out of a timeline
// row was proving a path no daemon can drive.
//
// Every clean assertion below has a negative control beside it, because a narrowing
// that accepted everything would pass both.

import { describe, expect, it } from "vitest";

import type { ConsoleSessionEvent } from "../../../console/store/index.js";
import {
  CONTEXT_COMPACTED_EVENT_KIND,
  CONTEXT_WINDOW_EVENT_KIND,
  newestCompactionBoundarySequence,
  newestContextWindowReading,
} from "./usage-readings.js";

const SESSION_ID = "session-under-test";

function event(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): ConsoleSessionEvent {
  return {
    // The event's own identifier, composed from the position so two rows of one
    // session never share one.
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    kind,
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

describe("newestContextWindowReading — the registered members, and a pair or nothing", () => {
  it("reads the registered payload and derives the percentage from its counts", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        windowUsedTokens: 124_000,
        windowMaxTokens: 200_000,
        windowSource: "provider_reported",
        exceeded: false,
      }),
    ]);
    expect(reading).toStrictEqual({
      usagePercent: 62,
      windowUsedTokens: 124_000,
      windowMaxTokens: 200_000,
      windowSource: "provider_reported",
      exceeded: false,
      sequence: 1,
    });
  });

  it("negative control: the fixture's own member names read as no payload at all", () => {
    // The finding itself. `usagePercent`, `tokenCount`, and `maxTokens` are names
    // this repository's fixtures used and no registered payload carries, so a
    // narrowing built on them could never have matched a daemon-sent row — and this
    // case is what fails if one is reintroduced.
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        usagePercent: 62,
        tokenCount: 124_000,
        maxTokens: 200_000,
      }),
    ]);
    expect(reading).toBeUndefined();
  });

  it("negative control: one half of the count pair yields nothing rather than a 0%", () => {
    // The counts travel as a pair. A numerator with no denominator would render as
    // 0% of an unknown window, which is a confident answer to a question the row
    // did not answer.
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, { windowUsedTokens: 124_000 }),
    ]);
    expect(reading).toBeUndefined();
  });

  it("negative control: a zero window is a size the row did not state", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, { windowUsedTokens: 0, windowMaxTokens: 0 }),
    ]);
    expect(reading).toBeUndefined();
  });

  it("carries the estimated grade rather than presenting it as a measurement", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        windowUsedTokens: 1,
        windowMaxTokens: 4,
        windowSource: "estimated",
      }),
    ]);
    expect(reading?.windowSource).toBe("estimated");
    expect(reading?.usagePercent).toBe(25);
  });

  it("refuses a provenance the registered vocabulary does not carry", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        windowUsedTokens: 1,
        windowMaxTokens: 4,
        windowSource: "guessed",
      }),
    ]);
    expect(reading?.windowSource).toBeUndefined();
  });

  it("clamps a window the provider reports more than full, rather than drawing nothing", () => {
    const reading = newestContextWindowReading([
      event(1, CONTEXT_WINDOW_EVENT_KIND, {
        windowUsedTokens: 21,
        windowMaxTokens: 10,
        exceeded: true,
      }),
    ]);
    expect(reading?.usagePercent).toBe(100);
    expect(reading?.exceeded).toBe(true);
  });

  it("takes the highest sequence, not the last element", () => {
    const reading = newestContextWindowReading([
      event(9, CONTEXT_WINDOW_EVENT_KIND, { windowUsedTokens: 8, windowMaxTokens: 10 }),
      event(2, CONTEXT_WINDOW_EVENT_KIND, { windowUsedTokens: 2, windowMaxTokens: 10 }),
    ]);
    expect(reading?.usagePercent).toBe(80);
  });
});

describe("newestCompactionBoundarySequence", () => {
  const FIRST_RUN = "run-first";
  const SECOND_RUN = "run-second";

  /** Two runs' boundaries in one session, the second run's the newer of the two. */
  const TWO_RUNS: readonly ConsoleSessionEvent[] = [
    event(4, CONTEXT_COMPACTED_EVENT_KIND, { runId: FIRST_RUN }),
    event(11, CONTEXT_COMPACTED_EVENT_KIND, { runId: SECOND_RUN }),
  ];

  it("finds the newest boundary row of the addressed run", () => {
    expect(
      newestCompactionBoundarySequence(
        [
          event(4, CONTEXT_COMPACTED_EVENT_KIND, { runId: FIRST_RUN }),
          event(11, CONTEXT_COMPACTED_EVENT_KIND, { runId: FIRST_RUN }),
        ],
        FIRST_RUN,
      ),
    ).toBe(11);
  });

  it("gives each run its own boundary out of one timeline", () => {
    // The defect this replaces, spelled as its own case: the unfiltered fold answered
    // 11 for BOTH runs, so a composer addressed at the first run reported the second
    // run's compaction as its own.
    expect(newestCompactionBoundarySequence(TWO_RUNS, FIRST_RUN)).toBe(4);
    expect(newestCompactionBoundarySequence(TWO_RUNS, SECOND_RUN)).toBe(11);
  });

  it("negative control: the newest row in the session is not the first run's", () => {
    // Without this the case above would pass over a fold that answered the OLDEST
    // row for everyone, which is a different wrong answer with the same shape.
    const sequences = TWO_RUNS.map((boundary) => boundary.sequence);
    expect(Math.max(...sequences)).toBe(11);
    expect(newestCompactionBoundarySequence(TWO_RUNS, FIRST_RUN)).not.toBe(11);
  });

  it("reads no boundary from a row carrying no readable run", () => {
    expect(
      newestCompactionBoundarySequence(
        [
          event(4, CONTEXT_COMPACTED_EVENT_KIND, {}),
          event(5, CONTEXT_COMPACTED_EVENT_KIND, { runId: "" }),
          event(6, CONTEXT_COMPACTED_EVENT_KIND, { runId: 7 }),
        ],
        FIRST_RUN,
      ),
    ).toBeUndefined();
  });

  it("asks for no boundary when no run is addressed", () => {
    expect(newestCompactionBoundarySequence(TWO_RUNS, undefined)).toBeUndefined();
  });

  it("negative control: a timeline with no boundary reports none", () => {
    expect(
      newestCompactionBoundarySequence(
        [event(4, CONTEXT_WINDOW_EVENT_KIND, { windowUsedTokens: 1, windowMaxTokens: 2 })],
        FIRST_RUN,
      ),
    ).toBeUndefined();
  });
});
