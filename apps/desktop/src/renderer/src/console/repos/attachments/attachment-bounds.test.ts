// The two bounds a user can walk into, read as figures rather than as gates.
//
// Each case pairs the reading with the thing it must not become: a count that reports
// a denominator without withdrawing anything, and a size comparison that answers
// "past the bound" without answering "do not send".

import { describe, expect, it } from "vitest";

import {
  ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
  ATTACHMENT_BYTE_CAP_DEFAULT,
} from "../../core/index.js";
import {
  SHIPPED_DEFAULT_ALLOWLIST,
  attachmentCarrierFill,
  exceedsAttachmentByteAllowance,
} from "./attachment-bounds.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "./attachment-policy.js";

describe("attachment bounds — the carrier's count against its allowance", () => {
  it("reports both halves, from the shipped bound rather than a figure of its own", () => {
    expect(attachmentCarrierFill(3)).toStrictEqual({
      attached: 3,
      allowance: ATTACHMENTS_PER_CARRIER_CAP_DEFAULT,
    });
  });

  it("still reports a count past the allowance rather than clamping it", () => {
    // The daemon refuses the whole carrier at acceptance and the console does not
    // stop the eleventh attach — so the eleventh has to be countable. A reading that
    // clamped would report ten attached over a carrier holding eleven, which is the
    // one number a user would use to work out what to take off.
    const past = attachmentCarrierFill(ATTACHMENTS_PER_CARRIER_CAP_DEFAULT + 1);
    expect(past.attached).toBe(ATTACHMENTS_PER_CARRIER_CAP_DEFAULT + 1);
    expect(past.allowance).toBe(ATTACHMENTS_PER_CARRIER_CAP_DEFAULT);
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

describe("attachment bounds — the shipped default", () => {
  it("names itself as the shipped default and carries no refusal of its own", () => {
    expect(SHIPPED_DEFAULT_ALLOWLIST.source).toBe("shipped-default");
    expect(SHIPPED_DEFAULT_ALLOWLIST.refusal).toBeUndefined();
  });

  it("is the policy module's list and the console's byte bound, not a third copy", () => {
    expect(SHIPPED_DEFAULT_ALLOWLIST.mediaTypes).toBe(ATTACHMENT_ALLOWLIST_DEFAULT);
    expect(SHIPPED_DEFAULT_ALLOWLIST.maximumByteLength).toBe(ATTACHMENT_BYTE_CAP_DEFAULT);
  });
});
