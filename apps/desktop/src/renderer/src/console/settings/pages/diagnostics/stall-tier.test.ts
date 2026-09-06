// How loud the stall badge gets, and the two cases where it gets no louder.
//
// The thresholds are the design's and live in `core/constants.ts`; what is asserted
// here is that they are read from there rather than restated, that both boundaries are
// inclusive on the escalating side, and that an interval nobody could compute produces
// no tier rather than the quietest one.

import { describe, expect, it } from "vitest";

import { STUCK_RUN_ESCALATION_MS, STUCK_RUN_NOTICE_MS } from "../../../core/index.js";
import { instantMilliseconds } from "../../../core/frozen-instant.test-support.js";
import { quietMillisecondsSince, stallTierFor } from "./stall-tier.js";

const READ_AT = instantMilliseconds("2026-01-01T08:00:00.000Z");

describe("stallTierFor", () => {
  it("is quiet below the notice bound", () => {
    expect(stallTierFor(STUCK_RUN_NOTICE_MS - 1)).toBe("quiet");
  });

  it("is noticed AT the notice bound, not one millisecond after it", () => {
    expect(stallTierFor(STUCK_RUN_NOTICE_MS)).toBe("noticed");
  });

  it("stays noticed below the escalation bound", () => {
    expect(stallTierFor(STUCK_RUN_ESCALATION_MS - 1)).toBe("noticed");
  });

  it("escalates AT the escalation bound", () => {
    expect(stallTierFor(STUCK_RUN_ESCALATION_MS)).toBe("escalated");
  });

  it("reports no tier for an interval that could not be measured", () => {
    expect(stallTierFor(undefined)).toBeUndefined();
  });

  it("reports no tier for a stamp ahead of the clock that read it", () => {
    // Two honest causes — a node whose clock runs ahead, and a fixture advanced past
    // a scripted instant — and in neither is the duration one anybody can stand
    // behind, so none is reported rather than a negative one being floored to quiet.
    expect(stallTierFor(-1)).toBeUndefined();
  });

  it("negative control: the same magnitude the other way does have a tier", () => {
    expect(stallTierFor(1)).toBe("quiet");
  });
});

describe("quietMillisecondsSince", () => {
  it("measures from the node's stamp to the instant the read settled", () => {
    expect(quietMillisecondsSince("2026-01-01T07:55:00.000Z", READ_AT)).toBe(300_000);
  });

  it("reports nothing for a stamp this console could not read", () => {
    expect(quietMillisecondsSince("not an instant", READ_AT)).toBeUndefined();
  });

  it("negative control: the same call with a readable stamp answers a number", () => {
    expect(quietMillisecondsSince("2026-01-01T08:00:00.000Z", READ_AT)).toBe(0);
  });
});
