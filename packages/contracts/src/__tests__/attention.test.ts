// The `attention.*` wire. A Notify step's entry is the one that names a step, and it is
// informational and carries its run; the delivery read shows a web address as its host
// only when one is saved.
import { describe, expect, it } from "vitest";

import { AttentionDeliveryReadResponseSchema, AttentionProjectionSchema } from "../attention.js";

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

describe("attention.deliveryRead", () => {
  const digest = { passwordSaved: false, lastOutcome: null };

  it("shows a saved address as its host with the last outcome", () => {
    const read = {
      webAddress: { saved: true, host: "ntfy.sh", lastOutcome: OUTCOME },
      emailDigest: digest,
    };
    expect(AttentionDeliveryReadResponseSchema.safeParse(read).success).toBe(true);
    // An attempt the address gave no answer to says so with a null status, never by leaving it out.
    const { httpStatus: _httpStatus, ...statusless } = OUTCOME;
    const omittedStatus = { ...read, webAddress: { ...read.webAddress, lastOutcome: statusless } };
    expect(AttentionDeliveryReadResponseSchema.safeParse(omittedStatus).success).toBe(false);
  });

  it("always carries host, a string only when an address is saved, null for a saved text", () => {
    // A saved text with no scheme and host reads a null host, and its test sends nothing.
    const notAnAddress = {
      at: "2026-09-24T14:14:00Z",
      result: "notAnAddress",
      httpStatus: null,
      undelivered: 0,
    };
    const savedNullHost = {
      webAddress: { saved: true, host: null, lastOutcome: notAnAddress },
      emailDigest: digest,
    };
    const hostWithoutSave = {
      webAddress: { saved: false, host: "ntfy.sh", lastOutcome: null },
      emailDigest: digest,
    };
    const omittedHost = {
      webAddress: { saved: true, lastOutcome: notAnAddress },
      emailDigest: digest,
    };
    expect(AttentionDeliveryReadResponseSchema.safeParse(savedNullHost).success).toBe(true);
    expect(AttentionDeliveryReadResponseSchema.safeParse(hostWithoutSave).success).toBe(false);
    expect(AttentionDeliveryReadResponseSchema.safeParse(omittedHost).success).toBe(false);
  });
});
