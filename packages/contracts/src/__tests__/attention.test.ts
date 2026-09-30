// The `attention.*` wire. The projection's entries say the name and the state the
// bell and the banner show, and a Notify step's entry is the one that names a step;
// main settles a banner once and never back to `pending`; the delivery read shows a
// web address as its host only when one is saved; the delivery verbs carry nothing
// but what the person typed, and the daemon, not the schema, decides whether an
// address can be sent to.
import { describe, expect, it } from "vitest";

import {
  AttentionBannerSettleRequestSchema,
  AttentionDeliveryReadResponseSchema,
  AttentionDeliveryStoreUnavailableDetailsSchema,
  AttentionDeliveryTestRequestSchema,
  AttentionEmptyMessageSchema,
  AttentionMailPasswordSaveRequestSchema,
  AttentionProjectionSchema,
  AttentionSeenUpdateRequestSchema,
  AttentionWebAddressInvalidDetailsSchema,
  AttentionWebAddressSaveRequestSchema,
} from "../attention.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

const WAITING_ENTRY = {
  id: "entry-1",
  momentId: "moment-1",
  sessionId: SESSION_ID,
  runId: "run-1",
  trigger: "pending_approval",
  severity: "actionable",
  displayName: "Fix the login flow",
  stateWord: "Waiting on you",
  summary: "An approval is waiting.",
  sourceEventId: "event-1",
  createdAt: "2026-09-24T14:14:00Z",
  bannerState: "pending",
  seen: false,
};

const NOTIFY_ENTRY = {
  ...WAITING_ENTRY,
  id: "entry-2",
  momentId: "moment-2",
  runId: "workflow-run-1",
  trigger: "workflow_notify",
  severity: "informational",
  displayName: "Nightly release",
  stateWord: "The release notes are ready.",
  stepId: "notify-1",
  bannerState: "posted",
};

const OUTCOME = { at: "2026-09-24T14:14:00Z", result: "refused", httpStatus: 404, undelivered: 3 };

describe("attention.projectionRead", () => {
  it("carries a waiting entry and a Notify step's entry, whole", () => {
    const projection = { items: [WAITING_ENTRY, NOTIFY_ENTRY] };
    expect(AttentionProjectionSchema.safeParse(projection).success).toBe(true);
  });

  it("refuses the retired mention trigger", () => {
    const mention = { ...WAITING_ENTRY, trigger: "mention" };
    expect(AttentionProjectionSchema.safeParse({ items: [mention] }).success).toBe(false);
  });

  it("names a step on a Notify step's entry and on no other", () => {
    const { stepId: _stepId, ...notifyWithoutStep } = NOTIFY_ENTRY;
    const waitingWithStep = { ...WAITING_ENTRY, stepId: "notify-1" };
    expect(AttentionProjectionSchema.safeParse({ items: [notifyWithoutStep] }).success).toBe(false);
    expect(AttentionProjectionSchema.safeParse({ items: [waitingWithStep] }).success).toBe(false);
  });

  it("refuses a Notify step's entry that waits on the person or names no run", () => {
    const actionable = { ...NOTIFY_ENTRY, severity: "actionable" };
    const { runId: _runId, ...runless } = NOTIFY_ENTRY;
    expect(AttentionProjectionSchema.safeParse({ items: [actionable] }).success).toBe(false);
    expect(AttentionProjectionSchema.safeParse({ items: [runless] }).success).toBe(false);
  });
});

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
    expect(AttentionSeenUpdateRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      true,
    );
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
