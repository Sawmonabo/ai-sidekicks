// Each machine-wide setting is changed one per press, with the page's own
// steps as the only values; something that is not a port or not a size is
// refused with nothing written. The package caches clear by name.
import { describe, expect, it } from "vitest";

import {
  DaemonConfigSchema,
  DaemonConfigUpdateRequestSchema,
  DaemonPackageCacheClearRequestSchema,
  DaemonPackageCacheReadingSchema,
} from "../daemon-config.js";

const CONFIG = {
  workflowListenerPort: 7391,
  runTimeLimitMinutes: null,
  workflowChainAskAfterRuns: 100,
  maxStepsPerTurn: null,
  toolMemoryCapBytes: null,
  toolMemoryCapEnforceable: true,
  packageCacheLimitBytes: null,
  recordTraces: false,
  recordReplayLog: false,
  replayLogPath: "/Users/person/.ai-sidekicks/logs/event-replay.jsonl",
} as const;

describe("daemon.configRead", () => {
  it("accepts the settings and the two facts beside them", () => {
    expect(DaemonConfigSchema.safeParse(CONFIG).success).toBe(true);
  });
});

describe("daemon.configUpdate", () => {
  it("accepts one setting, a step or its null", () => {
    expect(DaemonConfigUpdateRequestSchema.safeParse({ runTimeLimitMinutes: 240 }).success).toBe(
      true,
    );
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ workflowChainAskAfterRuns: null }).success,
    ).toBe(true);
  });

  it("refuses a value off the page's steps", () => {
    expect(DaemonConfigUpdateRequestSchema.safeParse({ runTimeLimitMinutes: 45 }).success).toBe(
      false,
    );
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ workflowChainAskAfterRuns: 50 }).success,
    ).toBe(false);
  });

  it("refuses what is not a port or not a size", () => {
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ workflowListenerPort: 70_000 }).success,
    ).toBe(false);
    expect(DaemonConfigUpdateRequestSchema.safeParse({ toolMemoryCapBytes: -5 }).success).toBe(
      false,
    );
  });

  it("refuses no setting, two, or a fact the service reports", () => {
    expect(DaemonConfigUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ recordTraces: true, recordReplayLog: true })
        .success,
    ).toBe(false);
    expect(
      DaemonConfigUpdateRequestSchema.safeParse({ toolMemoryCapEnforceable: false }).success,
    ).toBe(false);
  });
});

describe("the package caches", () => {
  it("reads both caches, each with its time", () => {
    const readAt = "2026-09-29T13:16:00.000Z";
    expect(
      DaemonPackageCacheReadingSchema.safeParse({
        bun: { bytes: 12_900_000, readAt },
        uv: { bytes: 4_200_000, readAt },
      }).success,
    ).toBe(true);
    expect(
      DaemonPackageCacheReadingSchema.safeParse({ bun: { bytes: 12_900_000, readAt } }).success,
    ).toBe(false);
  });

  it("clears a named cache or both, and nothing else", () => {
    expect(DaemonPackageCacheClearRequestSchema.safeParse({ cache: "all" }).success).toBe(true);
    expect(DaemonPackageCacheClearRequestSchema.safeParse({ cache: "npm" }).success).toBe(false);
  });
});
