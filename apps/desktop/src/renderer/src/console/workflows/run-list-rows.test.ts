// The rows, checked on the two things a derivation owes.
//
//   1. **The park discriminator is `parkReason` and never a phase's `state`.** So the
//      fixtures below deliberately put a park on a `running` phase and a `parkCause`
//      on a phase with no reason — the two shapes a `state`-reading projection gets
//      wrong in opposite directions.
//   2. **The rows really are derived from the wire shape rather than mirrored.** A
//      mirror agrees with its original until the original moves; the case at the
//      bottom drives a WHOLE wire phase through `phasePark` with no adaptation, so a
//      row that stopped being a subset of the substrate's declaration stops compiling
//      here rather than compiling on a vocabulary the wire has left behind.

import { describe, expect, it } from "vitest";

import type { WorkflowPhaseState } from "../bridge/index.js";
import { instantMilliseconds, parkSchedule, phasePark } from "./run-list-rows.js";
import { phase } from "./run-list-projection.test-support.js";

describe("the park discriminator", () => {
  it("reads a park off `parkReason` even on a phase whose state says running", () => {
    const park = phasePark(
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Approval needed." }),
    );
    expect(park?.parkReason).toBe("waiting-human");
  });

  it("negative control: a phase carrying a cause and no reason is not parked", () => {
    // A projection that keyed on any of the other three members would call this
    // parked. `parkCause` is the trap, because the producer emits it whenever it
    // emits a reason, so it looks interchangeable and is not.
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
   * A whole wire phase, every member of it — including the four the row drops.
   *
   * Typed as the substrate's own declaration on purpose: this value is the case's
   * subject, and typing it as a row would assert nothing about the wire at all.
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
    // Without this the case above would pass over a `WIRE_PHASE` that happened to
    // hold only the six members the row keeps, which proves nothing about the four
    // it does not.
    expect(WIRE_PHASE.gateState).toBe("open");
    expect(WIRE_PHASE.phaseRunId).toBe("phase-run-01");
    expect(WIRE_PHASE.attemptNumber).toBe(2);
    expect(WIRE_PHASE.formRevision).toBe(0);
  });
});

/*
 * A schedule is a PROMISE about a moment, so the value it is read from has to be a
 * moment. `Date.parse` is not that check: it answers a number for a timezone-less
 * `2026-01-01T10:00:00` by reading it in whatever zone the operator's machine is in,
 * and for a date-only `2026-01-01` by reading it in UTC — so both reached the armed
 * arm, and the badge drew "Scheduled to resume at" over a time nobody had sent.
 *
 * The cases below drive `parkSchedule`, which is where the consequence lands, and
 * `instantMilliseconds`, which is the single reading both this classification and the
 * run sort take. Each malformed shape carries the control that names why the shape
 * check is the thing doing the refusing.
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

  it("negative control: the host's own parser accepts that value and returns a number", () => {
    // The whole finding. Without this the case above would pass over a projection
    // that refused the value for some other reason — a length, a stray character —
    // and would not say that the permissive parse is what let it through.
    expect(Number.isNaN(Date.parse("2026-01-01T10:00:00"))).toBe(false);
    expect(instantMilliseconds("2026-01-01T10:00:00")).toBeUndefined();
  });

  it("refuses a date with no time on it", () => {
    expect(scheduleFor("2026-01-01").kind).toBe("unreadable");
  });

  it("negative control: the host's own parser accepts a bare date too", () => {
    expect(Number.isNaN(Date.parse("2026-01-01"))).toBe(false);
    expect(instantMilliseconds("2026-01-01")).toBeUndefined();
  });

  it("refuses a numeric offset, because this plane declares one encoding", () => {
    // Unambiguous to a parser and still not the encoding the wire declares. A console
    // that read a second one is where a producer's encoding change would enter
    // unremarked instead of arriving as the unreadable value it is.
    expect(scheduleFor("2026-01-01T10:00:00+01:00").kind).toBe("unreadable");
  });

  it("admits a well-formed UTC instant and carries its parsed reading on the arm", () => {
    // The control for every case above: a projection that refused everything would
    // satisfy all of them and leave no park schedulable at all.
    const schedule = scheduleFor("2026-01-01T10:00:00.000Z");
    expect(schedule.kind).toBe("armed");
    expect(schedule.kind === "armed" ? schedule.atMilliseconds : undefined).toBe(
      Date.parse("2026-01-01T10:00:00.000Z"),
    );
  });

  it("admits one with whole seconds and no fraction", () => {
    expect(scheduleFor("2026-01-01T10:00:00Z").kind).toBe("armed");
  });

  it("still refuses an instant-shaped value that names no time of day", () => {
    // Digit-shaped and not a clock reading. A pattern that matched two digits per
    // field admitted it and left `Date.parse` to refuse it; the validator refuses it
    // where every other malformed field is refused, which is why the arms below are
    // one claim rather than several.
    expect(scheduleFor("2026-09-01T99:99:99.000Z").kind).toBe("unreadable");
  });

  it("leaves a park that armed nothing unscheduled rather than unreadable", () => {
    // The two absences are different facts, and the guard must not fold one into the
    // other: nothing was armed here, so there is no malformed value to report.
    expect(
      parkSchedule({ parkReason: "waiting-human", parkCause: "Waiting for sign-off." }).kind,
    ).toBe("unscheduled");
  });
});

/**
 * A field that is digit-shaped and is not the day or the time it claims to be.
 *
 * The defect these close: the shape check matched digit GROUPS, so `2026-02-30`,
 * `2026-01-01T24:00:00Z` and `2027-02-29` all passed it — and `Date.parse` answers a
 * number for each, silently rolling the value forward into the next month or the next
 * day. The park then classified as `armed` and the badge advertised a resume on a date
 * the wire never sent, which is the one thing an armed schedule must never do.
 *
 * Each case carries the control that makes it bite: the host's own parser accepts the
 * value AND answers a different instant than the string names. Without that half, a
 * refusal here would prove only that something rejected the string.
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
    expect(instantMilliseconds(autoResumeAt)).toBeUndefined();
    expect(
      parkSchedule({
        parkReason: "provider-usage-limited",
        parkCause: "The account's allowance is spent.",
        autoResumeAt,
      }).kind,
    ).toBe("unreadable");
  });

  it("negative control: the host's parser answers a NUMBER for a day that does not exist", () => {
    // The finding in one line. `2026-02-30` is not a date and `Date.parse` reads it as
    // the second of March, so a park armed on it advertised a resume two days after
    // the one the daemon named — a wrong time drawn with a confident face.
    expect(Number.isNaN(Date.parse("2026-02-30T10:00:00Z"))).toBe(false);
    expect(new Date(Date.parse("2026-02-30T10:00:00Z")).toISOString()).toBe(
      "2026-03-02T10:00:00.000Z",
    );
  });

  it("negative control: and rolls the twenty-fourth hour into the next day", () => {
    expect(Number.isNaN(Date.parse("2026-01-01T24:00:00Z"))).toBe(false);
    expect(new Date(Date.parse("2026-01-01T24:00:00Z")).toISOString()).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("admits the twenty-ninth of February in a leap year", () => {
    // The control for every refusal above: a check that refused February the
    // twenty-ninth outright would satisfy the whole table and be wrong once every
    // four years, on a day a run is as likely to park as any other.
    expect(instantMilliseconds("2028-02-29T00:00:00Z")).toBe(Date.parse("2028-02-29T00:00:00Z"));
  });

  it("refuses it in a year that has no such day", () => {
    expect(instantMilliseconds("2027-02-29T00:00:00Z")).toBeUndefined();
  });

  it("negative control: the host's parser reads that same value as the first of March", () => {
    // Which is why the leap year has to be COMPUTED rather than pattern-matched: both
    // strings are digit-identical in shape and only one of them is a day.
    expect(new Date(Date.parse("2027-02-29T00:00:00Z")).toISOString()).toBe(
      "2027-03-01T00:00:00.000Z",
    );
  });
});
