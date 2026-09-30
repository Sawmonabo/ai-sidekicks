// Stop and restart answer only `accepted: true`; a refusal is the typed
// conflict, whose count is the list of other clients it names. The flush at
// quit and the ping take nothing.
import { describe, expect, it } from "vitest";

import {
  DaemonFlushResponseSchema,
  DaemonLifecycleAcceptedSchema,
  DaemonLifecycleConflictDetailsSchema,
  DaemonPingRequestSchema,
  DaemonStopRequestSchema,
} from "../daemon-lifecycle.js";

describe("daemon.stop and daemon.restart", () => {
  it("accepts a request with or without a drain deadline", () => {
    expect(DaemonStopRequestSchema.safeParse({}).success).toBe(true);
    expect(DaemonStopRequestSchema.safeParse({ idleDrainDeadlineMs: 250 }).success).toBe(true);
  });

  it("refuses a negative deadline or an unknown member", () => {
    expect(DaemonStopRequestSchema.safeParse({ idleDrainDeadlineMs: -1 }).success).toBe(false);
    expect(DaemonStopRequestSchema.safeParse({ force: true }).success).toBe(false);
  });

  it("answers only accepted: true", () => {
    expect(DaemonLifecycleAcceptedSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(DaemonLifecycleAcceptedSchema.safeParse({ accepted: false }).success).toBe(false);
  });

  it("names every other client still connected, and counts exactly those", () => {
    expect(
      DaemonLifecycleConflictDetailsSchema.safeParse({
        activeClientCount: 2,
        observedClientIds: ["cli-1", "desktop-2"],
      }).success,
    ).toBe(true);
    expect(
      DaemonLifecycleConflictDetailsSchema.safeParse({
        activeClientCount: 3,
        observedClientIds: ["cli-1", "desktop-2"],
      }).success,
    ).toBe(false);
    expect(
      DaemonLifecycleConflictDetailsSchema.safeParse({
        activeClientCount: 0,
        observedClientIds: [],
      }).success,
    ).toBe(false);
  });
});

describe("daemon.flush and daemon.ping", () => {
  it("answers a flush only once everything is durable", () => {
    expect(DaemonFlushResponseSchema.safeParse({ flushed: true }).success).toBe(true);
    expect(DaemonFlushResponseSchema.safeParse({ flushed: false }).success).toBe(false);
  });

  it("takes nothing on a ping", () => {
    expect(DaemonPingRequestSchema.safeParse({}).success).toBe(true);
    expect(DaemonPingRequestSchema.safeParse({ at: 1 }).success).toBe(false);
  });
});
