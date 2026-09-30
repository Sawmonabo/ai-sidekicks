// The two bounds a user can walk into, read as figures rather than as gates.
//
// Each case pairs the reading with the thing it must not become: a count that reports
// a denominator without withdrawing anything, and a size comparison that answers
// "past the bound" without answering "do not send".

import { describe, expect, it } from "vitest";

import { SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT } from "@ai-sidekicks/contracts";
import { stagedAttachmentsFill, exceedsAttachmentByteAllowance } from "./attachment-bounds.js";

describe("attachment bounds — the staged list's count against its allowance", () => {
  it("reports both halves, from the shipped bound rather than a figure of its own", () => {
    expect(stagedAttachmentsFill(3)).toStrictEqual({
      attached: 3,
      allowance: SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT,
    });
  });

  it("still reports a count past the allowance rather than clamping it", () => {
    // The daemon refuses the whole staged list at acceptance and the console does not
    // stop the eleventh attach — so the eleventh has to be countable. A reading that
    // clamped would report ten attached over a staged list holding eleven, which is the
    // one number a user would use to work out what to take off.
    const past = stagedAttachmentsFill(SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT + 1);
    expect(past.attached).toBe(SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT + 1);
    expect(past.allowance).toBe(SESSION_ATTACHMENTS_PER_MESSAGE_DEFAULT_LIMIT);
  });
});

describe("attachment bounds — one payload against the per-attachment allowance", () => {
  it("answers only at the boundary it is asked about", () => {
    expect(exceedsAttachmentByteAllowance(100, 100)).toBe(false);
    expect(exceedsAttachmentByteAllowance(101, 100)).toBe(true);
  });

  it("negative control: an empty payload inside a tiny bound is not past it", () => {
    // Without this the predicate could return `true` unconditionally and every case
    // above that expects `true` would still pass.
    expect(exceedsAttachmentByteAllowance(0, 1)).toBe(false);
  });
});
