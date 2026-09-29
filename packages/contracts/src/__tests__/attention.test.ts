// The `attention.*` wire beside the projection read. Main settles a banner once
// and never back to `pending`; the delivery read shows a web address as its host
// only when one is saved; the delivery verbs carry nothing but what the person
// typed, and the daemon, not the schema, decides whether an address can be sent to.
import { describe, expect, it } from "vitest";

import {
  AttentionBannerSettleRequestSchema,
  AttentionDeliveryReadResponseSchema,
  AttentionDeliveryStoreUnavailableDetailsSchema,
  AttentionDeliveryTestRequestSchema,
  AttentionEmptyMessageSchema,
  AttentionMailPasswordSaveRequestSchema,
  AttentionSeenUpdateRequestSchema,
  AttentionWebAddressInvalidDetailsSchema,
  AttentionWebAddressSaveRequestSchema,
} from "../attention.js";

const OUTCOME = { at: "2026-09-24T14:14:00Z", result: "refused", httpStatus: 404, undelivered: 3 };

describe("attention.bannerSettle and attention.seenUpdate", () => {
  it("settles a banner as posted, withheld or withdrawn, never back to pending", () => {
    expect(
      AttentionBannerSettleRequestSchema.safeParse({ entryId: "entry-1", state: "posted" }).success,
    ).toBe(true);
    expect(
      AttentionBannerSettleRequestSchema.safeParse({ entryId: "entry-1", state: "pending" })
        .success,
    ).toBe(false);
    expect(AttentionBannerSettleRequestSchema.safeParse({ state: "withdrawn" }).success).toBe(
      false,
    );
  });

  it("marks a session seen by its id", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    expect(AttentionSeenUpdateRequestSchema.safeParse({ sessionId }).success).toBe(true);
    expect(AttentionSeenUpdateRequestSchema.safeParse({ sessionId: "session-1" }).success).toBe(
      false,
    );
  });
});

describe("attention.deliveryRead", () => {
  const digest = { passwordSaved: false, lastOutcome: null };

  it("shows a saved address as its host with the last outcome", () => {
    const read = {
      webAddress: { saved: true, host: "ntfy.sh", lastOutcome: OUTCOME },
      emailDigest: digest,
    };
    expect(AttentionDeliveryReadResponseSchema.safeParse(read).success).toBe(true);
  });

  it("carries a host exactly when an address is saved", () => {
    const savedWithoutHost = {
      webAddress: { saved: true, host: null, lastOutcome: null },
      emailDigest: digest,
    };
    const hostWithoutSave = {
      webAddress: { saved: false, host: "ntfy.sh", lastOutcome: null },
      emailDigest: digest,
    };
    expect(AttentionDeliveryReadResponseSchema.safeParse(savedWithoutHost).success).toBe(false);
    expect(AttentionDeliveryReadResponseSchema.safeParse(hostWithoutSave).success).toBe(false);
  });

  it("refuses an outcome outside the six results", () => {
    const read = {
      webAddress: { saved: true, host: "ntfy.sh", lastOutcome: { ...OUTCOME, result: "bounced" } },
      emailDigest: digest,
    };
    expect(AttentionDeliveryReadResponseSchema.safeParse(read).success).toBe(false);
  });
});

describe("the delivery verbs", () => {
  it("tests one of the two channels", () => {
    expect(AttentionDeliveryTestRequestSchema.safeParse({ channel: "emailDigest" }).success).toBe(
      true,
    );
    expect(AttentionDeliveryTestRequestSchema.safeParse({ channel: "slack" }).success).toBe(false);
  });

  it("refuses an empty mail password", () => {
    expect(AttentionMailPasswordSaveRequestSchema.safeParse({ password: "" }).success).toBe(false);
  });

  it("leaves an unparseable address for the daemon to refuse with its reason", () => {
    expect(
      AttentionWebAddressSaveRequestSchema.safeParse({ address: "not an address" }).success,
    ).toBe(true);
  });

  it("removes and rotates with an empty request", () => {
    expect(AttentionEmptyMessageSchema.safeParse({}).success).toBe(true);
    expect(AttentionEmptyMessageSchema.safeParse({ password: "hunter2" }).success).toBe(false);
  });
});

describe("the delivery refusals' details", () => {
  it("names a closed reason and a closed cause", () => {
    expect(AttentionWebAddressInvalidDetailsSchema.safeParse({ reason: "notHttps" }).success).toBe(
      true,
    );
    expect(AttentionWebAddressInvalidDetailsSchema.safeParse({ reason: "blocked" }).success).toBe(
      false,
    );
    expect(
      AttentionDeliveryStoreUnavailableDetailsSchema.safeParse({ cause: "locked" }).success,
    ).toBe(true);
    expect(
      AttentionDeliveryStoreUnavailableDetailsSchema.safeParse({ cause: "missing" }).success,
    ).toBe(false);
  });
});
