// The seating rule: every run the session knows gets a row, and the ones the live
// tail has not described are named rather than dropped.
//
// Asserted on the pure model rather than through a rendered tree, because the claim
// is about which rows exist and in what order — a question with an answer the
// renderer only displays.

import { describe, expect, it } from "vitest";

import type { ConsoleEntity } from "../../store/index.js";
import { seatRuns } from "./run-seating.js";
import { RunStateProjection, type RunProjection } from "./run-state-projection.js";

const RUN_A = "a1b2c3d4-5e6f-4071-8182-93a4b5c6d7e8";
const RUN_B = "b2c3d4e5-6f70-4182-9293-a4b5c6d7e8f9";
const RUN_C = "c3d4e5f6-7081-4293-83a4-b5c6d7e8f901";

/** One partition entity, as `frame/run-lifecycle-projector.ts` folds one. */
function knownEntity(runId: string, overrides: Partial<ConsoleEntity> = {}): ConsoleEntity {
  return { kind: "run", id: runId, state: "completed", ...overrides };
}

/** One live projection, through the real fold rather than a hand-built shape. */
function projectionOf(runId: string, touchedAtIso: string): RunProjection {
  const fold = new RunStateProjection();
  fold.accept({
    runId,
    runVersion: 2,
    previousState: "queued",
    currentState: "running",
    timestamp: touchedAtIso,
  });
  const projected = fold.runs()[0];
  if (projected === undefined) {
    throw new Error("the fold produced no run for the seating test");
  }
  return projected;
}

describe("every known run seats a row", () => {
  it("seats a row for a run the stream has not described", () => {
    const seating = seatRuns({ [RUN_A]: knownEntity(RUN_A) }, []);
    expect(seating.rows).toHaveLength(1);
    expect(seating.rows[0]?.source).toBe("known");
    expect(seating.awaitingProjectionRunIds).toStrictEqual([RUN_A]);
  });

  it("overlays the projection where the stream described the same run", () => {
    const seating = seatRuns({ [RUN_A]: knownEntity(RUN_A) }, [
      projectionOf(RUN_A, "2026-01-01T10:00:00.000Z"),
    ]);
    expect(seating.rows).toHaveLength(1);
    expect(seating.rows[0]?.source).toBe("projected");
    expect(seating.awaitingProjectionRunIds).toStrictEqual([]);
  });

  it("seats a projected run the partition has not caught up with", () => {
    // The newest thing that happened is not dropped because the snapshot is behind.
    const seating = seatRuns({}, [projectionOf(RUN_B, "2026-01-01T10:00:00.000Z")]);
    expect(seating.rows.map((row) => row.runId)).toStrictEqual([RUN_B]);
    expect(seating.awaitingProjectionRunIds).toStrictEqual([]);
  });

  it("keeps the feed's order and appends the runs it has not described", () => {
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A, { touchedAt: "2026-01-01T09:00:00.000Z" }),
        [RUN_B]: knownEntity(RUN_B, { touchedAt: "2026-01-01T11:00:00.000Z" }),
        [RUN_C]: knownEntity(RUN_C),
      },
      [projectionOf(RUN_C, "2026-01-01T10:00:00.000Z")],
    );
    // The projection first, then the two undescribed runs newest-touched first.
    expect(seating.rows.map((row) => row.runId)).toStrictEqual([RUN_C, RUN_B, RUN_A]);
    expect(seating.awaitingProjectionRunIds).toStrictEqual([RUN_B, RUN_A]);
  });

  it("negative control: an empty partition and an empty stream seat no rows", () => {
    // Without this the cases above would pass over a seat that invented a row for
    // every call, which would make the pane's empty state unreachable.
    const seating = seatRuns({}, []);
    expect(seating.rows).toStrictEqual([]);
    expect(seating.awaitingProjectionRunIds).toStrictEqual([]);
  });
});

describe("the record's own facts, at the type the durable payload declares", () => {
  it("carries the terminal facts a run stopped with", () => {
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A, {
          state: "failed",
          touchedAt: "2026-01-01T12:00:00.000Z",
          body: {
            runVersion: 7,
            trigger: "idle_timeout",
            intendedClose: true,
            failureCategory: "provider_error",
            providerFailureDetail: "the provider closed the stream",
          },
        }),
      },
      [],
    );
    const seated = seating.rows[0];
    expect(seated?.source === "known" ? seated.known : undefined).toStrictEqual({
      runId: RUN_A,
      state: "failed",
      runVersion: 7,
      touchedAtIso: "2026-01-01T12:00:00.000Z",
      stopTrigger: "idle_timeout",
      intendedClose: true,
      failureCategory: "provider_error",
      providerFailureDetail: "the provider closed the stream",
    });
  });

  it("drops a member the payload supplied at the wrong type rather than casting it", () => {
    // A figure read at the wrong type would reach a row as a rendered value the
    // daemon never sent, which is the one thing a wire figure may not be.
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A, {
          body: { runVersion: "seven", trigger: 4, failureCategory: "" },
        }),
      },
      [],
    );
    const seated = seating.rows[0];
    const known = seated?.source === "known" ? seated.known : undefined;
    expect(known?.runVersion).toBeUndefined();
    expect(known?.stopTrigger).toBeUndefined();
    expect(known?.failureCategory).toBeUndefined();
    expect(known?.intendedClose).toBe(false);
  });

  it("negative control: the same members at their declared types are carried", () => {
    // Proves the case above reads the type rather than dropping every body member.
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A, {
          body: { runVersion: 7, trigger: "idle_timeout", failureCategory: "provider_error" },
        }),
      },
      [],
    );
    const seated = seating.rows[0];
    const known = seated?.source === "known" ? seated.known : undefined;
    expect(known?.runVersion).toBe(7);
    expect(known?.stopTrigger).toBe("idle_timeout");
    expect(known?.failureCategory).toBe("provider_error");
  });
});

describe("known runs are seated by the moment their stamp names", () => {
  it("seats an offset stamp by its moment rather than by its text", () => {
    // `2026-01-01T10:00:00+01:00` is 09:00Z and sorts AFTER `2026-01-01T09:30:00Z`
    // as text while naming an EARLIER moment, so a lexical comparison puts the older
    // run at the top of the list — stably, and with nothing reporting it.
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A, { touchedAt: "2026-01-01T10:00:00+01:00" }),
        [RUN_B]: knownEntity(RUN_B, { touchedAt: "2026-01-01T09:30:00Z" }),
      },
      [],
    );
    expect(seating.rows.map((row) => row.runId)).toStrictEqual([RUN_B, RUN_A]);
  });

  it("negative control: the same two moments spelled in one offset seat the same way", () => {
    // Without this the case above would pass over a comparator that simply reversed
    // the text order. Same instants, both in Z, so text and moment agree — and the
    // seating must be the same list.
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A, { touchedAt: "2026-01-01T09:00:00Z" }),
        [RUN_B]: knownEntity(RUN_B, { touchedAt: "2026-01-01T09:30:00Z" }),
      },
      [],
    );
    expect(seating.rows.map((row) => row.runId)).toStrictEqual([RUN_B, RUN_A]);
  });

  it("seats a run with no stamp last, whichever way the readable ones fall", () => {
    const seating = seatRuns(
      {
        [RUN_A]: knownEntity(RUN_A),
        [RUN_B]: knownEntity(RUN_B, { touchedAt: "2026-01-01T09:30:00Z" }),
        [RUN_C]: knownEntity(RUN_C, { touchedAt: "2026-01-01T10:00:00+01:00" }),
      },
      [],
    );
    expect(seating.rows.map((row) => row.runId)).toStrictEqual([RUN_B, RUN_C, RUN_A]);
  });
});
