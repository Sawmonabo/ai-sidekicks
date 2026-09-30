// The rows, checked on the two things a derivation owes: the park discriminator is `parkReason`
// and never a phase's `state` (fixtures put a park on a `running` phase and a `parkCause` on a
// phase with no reason), and the rows are derived from the wire shape (the last case drives a whole
// wire phase through `phasePark` with no adaptation).

import { describe, expect, it } from "vitest";

import type { WorkflowPhaseState } from "@renderer/services/wire-shapes/workflow-projection.js";
import { parkSchedule, phasePark, workflowInstant } from "./run-list-rows.js";
import { phase } from "./run-list-projection.test-support.js";

describe("the park discriminator", () => {
  it("reads a park off `parkReason` even on a phase whose state says running", () => {
    const park = phasePark(
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Approval needed." }),
    );
    expect(park?.parkReason).toBe("waiting-human");
  });

  it("negative control: a phase carrying a cause and no reason is not parked", () => {
    // `parkCause` is the trap: the producer emits it whenever it emits a reason, so it looks
    // interchangeable and is not.
    expect(phasePark(phase({ parkCause: "Approval needed." }))).toBeUndefined();
  });

  it("negative control: a phase with no park members at all is not parked", () => {
    expect(phasePark(phase({ state: "pending" }))).toBeUndefined();
  });

  it("carries the armed schedule and the attention key through untouched", () => {
    const park = phasePark(
      phase({
        parkReason: "provider-usage-limited",
        parkCause: "Account allowance spent until 11:30.",
        autoResumeAt: "2026-09-01T11:30:00.000Z",
        parkAttentionKey: "account-7",
      }),
    );
    expect(park?.autoResumeAt).toBe("2026-09-01T11:30:00.000Z");
    expect(park?.parkAttentionKey).toBe("account-7");
  });
});

describe("the rows are a narrowing of the wire shape, not a second one", () => {
  /**
   * A whole wire phase, every member of it including the four the row drops. Typed as the
   * substrate's declaration on purpose: typing it as a row would assert nothing about the wire.
   */
  const WIRE_PHASE: WorkflowPhaseState = {
    phaseId: "phase-review",
    phaseRunId: "phase-run-01",
    attemptNumber: 2,
    state: "running",
    gateState: "open",
    formRevision: 0,
    parkReason: "waiting-human",
    parkCause: "Approval needed.",
    parkAttentionKey: "account-7",
  };

  it("reads a park straight off a wire phase, with nothing adapted in between", () => {
    expect(phasePark(WIRE_PHASE)?.parkReason).toBe("waiting-human");
  });

  it("negative control: the wire phase really does carry the members a row drops", () => {
    expect(WIRE_PHASE.gateState).toBe("open");
    expect(WIRE_PHASE.phaseRunId).toBe("phase-run-01");
    expect(WIRE_PHASE.attemptNumber).toBe(2);
    expect(WIRE_PHASE.formRevision).toBe(0);
  });
});

/*
 * A schedule promises a moment, so the value must be one. `Date.parse` reads a timezone-less
 * `2026-01-01T10:00:00` in the host's zone, a date-only `2026-01-01` in UTC, and moves
 * `2026-02-30T10:00:00Z` to March. That the host parser accepts them is asserted in
 * `lib/instant.test.ts`; the cases here check that `parkSchedule` and `workflowInstant` refuse
 * each shape and admit the spellings `workflowInstant` declares.
 */
describe("an armed boundary is an instant or it is unreadable", () => {
  function scheduleFor(autoResumeAt: string): ReturnType<typeof parkSchedule> {
    return parkSchedule({
      parkReason: "provider-usage-limited",
      parkCause: "The account's allowance is spent.",
      autoResumeAt,
    });
  }

  it("refuses a timezone-less instant rather than reading it in the host's zone", () => {
    expect(scheduleFor("2026-01-01T10:00:00").kind).toBe("unreadable");
  });

  it("and the reading the park classification and the run sort share refuses it too", () => {
    // Guards the case above against a classification that refused the value for another reason.
    expect(workflowInstant("2026-01-01T10:00:00").kind).toBe("malformed");
  });

  it("refuses a date with no time on it", () => {
    expect(scheduleFor("2026-01-01").kind).toBe("unreadable");
  });

  it("and the reading refuses a bare date too", () => {
    expect(workflowInstant("2026-01-01").kind).toBe("malformed");
  });

  it("refuses a numeric offset, because the workflow projection declares one encoding", () => {
    // Unambiguous to a parser, but not the encoding the wire declares.
    expect(scheduleFor("2026-01-01T10:00:00+01:00").kind).toBe("unreadable");
  });

  it("admits a well-formed UTC instant and carries the wire's own spelling on the arm", () => {
    // Guards every case above against a projection that refused everything. The arm carries the
    // wire's string and no parsed number.
    expect(scheduleFor("2026-01-01T10:00:00.000Z")).toStrictEqual({
      kind: "armed",
      autoResumeAt: "2026-01-01T10:00:00.000Z",
    });
  });

  it("admits one with whole seconds and no fraction", () => {
    expect(scheduleFor("2026-01-01T10:00:00Z").kind).toBe("armed");
  });

  it("still refuses an instant-shaped value that names no time of day", () => {
    // Digit-shaped but not a clock reading; the reader refuses it like every other malformed
    // field.
    expect(scheduleFor("2026-09-01T99:99:99.000Z").kind).toBe("unreadable");
  });

  it("leaves a park that armed nothing unscheduled rather than unreadable", () => {
    // Nothing armed here, so there is no malformed value to report.
    expect(
      parkSchedule({ parkReason: "waiting-human", parkCause: "Waiting for sign-off." }).kind,
    ).toBe("unscheduled");
  });
});

/**
 * Fields that are digit-shaped but not the day or time they claim: `2026-02-30`,
 * `2026-01-01T24:00:00Z` and `2027-02-29` pass a digit-group check, and the host parser rolls
 * each into the next month or day. Why each bites is asserted in `lib/instant.test.ts`.
 */
describe("a calendar and a clock, not four groups of digits", () => {
  /** Every field an instant declares, at a value that is out of its own range. */
  const OUT_OF_RANGE_FIELDS: readonly (readonly [string, string])[] = [
    ["a month past December", "2026-13-01T00:00:00Z"],
    ["a zeroth month", "2026-00-01T00:00:00Z"],
    ["a day past the end of February", "2026-02-30T10:00:00Z"],
    ["a thirty-first of April", "2026-04-31T00:00:00Z"],
    ["a zeroth day", "2026-01-00T00:00:00Z"],
    ["the twenty-fourth hour", "2026-01-01T24:00:00Z"],
    ["a sixtieth minute", "2026-01-01T23:60:00Z"],
    ["a sixtieth second", "2026-01-01T23:59:60Z"],
  ];

  it.each(OUT_OF_RANGE_FIELDS)("refuses %s", (_field, autoResumeAt) => {
    expect(workflowInstant(autoResumeAt).kind).toBe("malformed");
    expect(
      parkSchedule({
        parkReason: "provider-usage-limited",
        parkCause: "The account's allowance is spent.",
        autoResumeAt,
      }).kind,
    ).toBe("unreadable");
  });

  it("admits the twenty-ninth of February in a leap year", () => {
    // Guards the table against a check that refused every February 29.
    expect(workflowInstant("2028-02-29T00:00:00Z").epochMilliseconds).toBe(
      Date.UTC(2028, 1, 29, 0, 0, 0, 0),
    );
  });

  it("refuses it in a year that has no such day", () => {
    // The leap year must be computed, not pattern-matched: this string and the one above are
    // digit-identical in shape. What the host parser makes of each is in `lib/instant.test.ts`.
    expect(workflowInstant("2027-02-29T00:00:00Z").kind).toBe("malformed");
  });
});
