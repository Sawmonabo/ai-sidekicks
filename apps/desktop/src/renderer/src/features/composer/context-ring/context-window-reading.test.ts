// The usage fold: a half count pair yields no reading, and a reading or compaction boundary
// belongs to the addressed run or to nobody. Each clean assertion has a negative control beside
// it, since a narrowing that accepted everything would pass both.

import { describe, expect, it } from "vitest";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  CONTEXT_COMPACTED_EVENT_KIND,
  CONTEXT_WINDOW_EVENT_KIND,
  newestContextWindowReading,
} from "./context-window-reading.js";

const SESSION_ID = "session-under-test";
const FIRST_RUN = "run-first";
const SECOND_RUN = "run-second";

function event(
  sequence: number,
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): ProjectedSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId: SESSION_ID,
    sequence,
    kind,
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload,
  };
}

describe("newestContextWindowReading — the registered members, and a pair or nothing", () => {
  function windowRow(
    sequence: number,
    payload: Readonly<Record<string, unknown>>,
  ): ProjectedSessionEvent {
    return event(sequence, CONTEXT_WINDOW_EVENT_KIND, { runId: FIRST_RUN, ...payload });
  }

  it("reads the registered payload and derives the percentage from its counts", () => {
    const reading = newestContextWindowReading(
      [
        windowRow(1, {
          windowUsedTokens: 124_000,
          windowMaxTokens: 200_000,
          windowSource: "provider_reported",
          exceeded: false,
        }),
      ],
      FIRST_RUN,
    );
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
    // Names no registered payload carries: a narrowing built on them could never match a
    // daemon-sent row.
    const reading = newestContextWindowReading(
      [windowRow(1, { usagePercent: 62, tokenCount: 124_000, maxTokens: 200_000 })],
      FIRST_RUN,
    );
    expect(reading).toBeUndefined();
  });

  it("negative control: one half of the count pair yields nothing rather than a 0%", () => {
    const reading = newestContextWindowReading(
      [windowRow(1, { windowUsedTokens: 124_000 })],
      FIRST_RUN,
    );
    expect(reading).toBeUndefined();
  });

  it("negative control: a zero window is a size the row did not state", () => {
    const reading = newestContextWindowReading(
      [windowRow(1, { windowUsedTokens: 0, windowMaxTokens: 0 })],
      FIRST_RUN,
    );
    expect(reading).toBeUndefined();
  });

  it("carries the estimated grade rather than presenting it as a measurement", () => {
    const reading = newestContextWindowReading(
      [windowRow(1, { windowUsedTokens: 1, windowMaxTokens: 4, windowSource: "estimated" })],
      FIRST_RUN,
    );
    expect(reading?.windowSource).toBe("estimated");
    expect(reading?.usagePercent).toBe(25);
  });

  it("refuses a provenance the registered vocabulary does not carry", () => {
    const reading = newestContextWindowReading(
      [windowRow(1, { windowUsedTokens: 1, windowMaxTokens: 4, windowSource: "guessed" })],
      FIRST_RUN,
    );
    expect(reading?.windowSource).toBeUndefined();
  });

  it("clamps a window the provider reports more than full, rather than drawing nothing", () => {
    const reading = newestContextWindowReading(
      [windowRow(1, { windowUsedTokens: 21, windowMaxTokens: 10, exceeded: true })],
      FIRST_RUN,
    );
    expect(reading?.usagePercent).toBe(100);
    expect(reading?.exceeded).toBe(true);
  });

  it("takes the highest sequence, not the last element", () => {
    const reading = newestContextWindowReading(
      [
        windowRow(9, { windowUsedTokens: 8, windowMaxTokens: 10 }),
        windowRow(2, { windowUsedTokens: 2, windowMaxTokens: 10 }),
      ],
      FIRST_RUN,
    );
    expect(reading?.usagePercent).toBe(80);
  });
});

describe("newestContextWindowReading — one run's fullness and never the session's", () => {
  /** Two metered runs; the second run's row is the newer one. */
  const TWO_METERED_RUNS: readonly ProjectedSessionEvent[] = [
    event(3, CONTEXT_WINDOW_EVENT_KIND, {
      runId: FIRST_RUN,
      windowUsedTokens: 20,
      windowMaxTokens: 100,
    }),
    event(12, CONTEXT_WINDOW_EVENT_KIND, {
      runId: SECOND_RUN,
      windowUsedTokens: 90,
      windowMaxTokens: 100,
    }),
  ];

  it("answers each addressed run with its own reading", () => {
    // A fold over the newest row anywhere would report the second run's 90% to the first.
    expect(newestContextWindowReading(TWO_METERED_RUNS, FIRST_RUN)?.usagePercent).toBe(20);
    expect(newestContextWindowReading(TWO_METERED_RUNS, SECOND_RUN)?.usagePercent).toBe(90);
  });

  it("negative control: the newest row in the session is the second run's", () => {
    // Without this, the case above would also pass a fold that answered the oldest row.
    const sequences = TWO_METERED_RUNS.map((row) => row.sequence);
    expect(Math.max(...sequences)).toBe(12);
    expect(newestContextWindowReading(TWO_METERED_RUNS, FIRST_RUN)?.usagePercent).not.toBe(90);
  });

  it("reads no fullness from a row carrying no readable run", () => {
    // `runId` is optional on the wire, so unattributed rows exist; counting one as the
    // addressed run's would be a fabrication.
    expect(
      newestContextWindowReading(
        [
          event(4, CONTEXT_WINDOW_EVENT_KIND, { windowUsedTokens: 1, windowMaxTokens: 2 }),
          event(5, CONTEXT_WINDOW_EVENT_KIND, {
            runId: "",
            windowUsedTokens: 1,
            windowMaxTokens: 2,
          }),
          event(6, CONTEXT_WINDOW_EVENT_KIND, {
            runId: 7,
            windowUsedTokens: 1,
            windowMaxTokens: 2,
          }),
        ],
        FIRST_RUN,
      ),
    ).toBeUndefined();
  });

  it("asks for no reading when no run is addressed", () => {
    expect(newestContextWindowReading(TWO_METERED_RUNS, undefined)).toBeUndefined();
  });
});

describe("newestContextWindowReading — a compaction supersedes the last update", () => {
  /** 90% full: the stale figure a compaction must supersede. */
  function nearlyFull(sequence: number): ProjectedSessionEvent {
    return event(sequence, CONTEXT_WINDOW_EVENT_KIND, {
      runId: FIRST_RUN,
      windowUsedTokens: 180_000,
      windowMaxTokens: 200_000,
      windowSource: "provider_reported",
      exceeded: false,
    });
  }

  function compacted(
    sequence: number,
    payload: Readonly<Record<string, unknown>> = {},
  ): ProjectedSessionEvent {
    return event(sequence, CONTEXT_COMPACTED_EVENT_KIND, { runId: FIRST_RUN, ...payload });
  }

  it("restates the ratio from the boundary's own post-compaction count", () => {
    const reading = newestContextWindowReading(
      [nearlyFull(4), compacted(9, { preCompactionTokens: 180_000, postCompactionTokens: 40_000 })],
      FIRST_RUN,
    );
    expect(reading).toStrictEqual({
      usagePercent: 20,
      windowUsedTokens: 40_000,
      // The window the superseded update measured: a compaction shrinks the conversation, not
      // the window.
      windowMaxTokens: 200_000,
      windowSource: "provider_reported",
      exceeded: undefined,
      sequence: 9,
    });
  });

  it("negative control: without the boundary the pre-compaction figure stands", () => {
    const reading = newestContextWindowReading([nearlyFull(4)], FIRST_RUN);
    expect(reading?.usagePercent).toBe(90);
  });

  it("reads no ratio at all from a boundary that carried no count", () => {
    // The wire's other arm: unknown until the next update, so no stale figure may linger.
    expect(newestContextWindowReading([nearlyFull(4), compacted(9)], FIRST_RUN)).toBeUndefined();
  });

  it("drops the exhaustion flag the superseded update carried", () => {
    // A compaction ends the window state `exceeded` reported, so it is not carried forward.
    const reading = newestContextWindowReading(
      [
        event(4, CONTEXT_WINDOW_EVENT_KIND, {
          runId: FIRST_RUN,
          windowUsedTokens: 210_000,
          windowMaxTokens: 200_000,
          windowSource: "estimated",
          exceeded: true,
        }),
        compacted(9, { postCompactionTokens: 20_000 }),
      ],
      FIRST_RUN,
    );
    expect(reading?.exceeded).toBeUndefined();
    // The grade rides across, because it grades the window the ratio still uses.
    expect(reading?.windowSource).toBe("estimated");
    expect(reading?.usagePercent).toBe(10);
  });

  it("lets the next update replace the boundary's reading", () => {
    const reading = newestContextWindowReading(
      [
        nearlyFull(4),
        compacted(9, { postCompactionTokens: 40_000 }),
        event(14, CONTEXT_WINDOW_EVENT_KIND, {
          runId: FIRST_RUN,
          windowUsedTokens: 60_000,
          windowMaxTokens: 200_000,
          windowSource: "provider_reported",
          exceeded: false,
        }),
      ],
      FIRST_RUN,
    );
    expect(reading?.usagePercent).toBe(30);
    expect(reading?.sequence).toBe(14);
  });

  it("negative control: an OLDER boundary supersedes nothing", () => {
    // Without this, the case above would pass a fold where any past boundary blanks later readings.
    const reading = newestContextWindowReading(
      [compacted(2, { postCompactionTokens: 1_000 }), nearlyFull(4)],
      FIRST_RUN,
    );
    expect(reading?.usagePercent).toBe(90);
    expect(reading?.sequence).toBe(4);
  });

  it("reads no ratio where the boundary is the only row this run has", () => {
    // A post-compaction count with no reported window has no denominator.
    expect(
      newestContextWindowReading([compacted(9, { postCompactionTokens: 40_000 })], FIRST_RUN),
    ).toBeUndefined();
  });

  it("leaves the addressed run's reading alone when another run compacts", () => {
    const reading = newestContextWindowReading(
      [
        nearlyFull(4),
        event(9, CONTEXT_COMPACTED_EVENT_KIND, {
          runId: SECOND_RUN,
          postCompactionTokens: 40_000,
        }),
      ],
      FIRST_RUN,
    );
    expect(reading?.usagePercent).toBe(90);
  });
});
