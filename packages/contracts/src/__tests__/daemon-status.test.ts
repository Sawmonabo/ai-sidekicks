// Settings › Runtime and `sidekicks daemon status` render one status reply, so
// every fact either prints must be on it, each reading stamped with its time,
// and the relay block absent rather than empty when no relay is configured.
import { describe, expect, it } from "vitest";

import { DaemonCrashListResponseSchema, DaemonStatusReadResponseSchema } from "../daemon-status.js";

const READ_AT = "2026-09-29T18:00:00.000Z";

const STATUS = {
  processState: "running",
  version: "0.1.0",
  protocolVersion: "2026-09-01",
  transportEndpoint: "/Users/person/.ai-sidekicks/daemon.sock",
  startedAt: "2026-09-29T15:00:00.000Z",
  uptimeMs: 10_800_000,
  dataDirectory: "/Users/person/.ai-sidekicks",
  processor: { percent: 3.5, readAt: READ_AT },
  memory: { residentBytes: 412_000_000, readAt: READ_AT },
  approvalRules: { version: 42, builtAt: "2026-09-20T00:00:00.000Z", source: "update" },
  fileScanning: "none",
  sidecarHashMismatch: null,
} as const;

describe("daemon.status.read's reply", () => {
  it("accepts the service's facts with no relay configured", () => {
    expect(DaemonStatusReadResponseSchema.safeParse(STATUS).success).toBe(true);
  });

  it("accepts the relay block and a refused sidecar", () => {
    expect(
      DaemonStatusReadResponseSchema.safeParse({
        ...STATUS,
        sidecarHashMismatch: {
          path: "/Applications/AI Sidekicks.app/Contents/Resources/sidekicks-pty",
          expectedSha256: "a".repeat(64),
          actualSha256: "b".repeat(64),
        },
        relay: {
          devices: [
            {
              name: "Phone",
              connected: true,
              lastFrameOutAgeMs: 1_200,
              reconnectCount: 0,
              rejectedFrameCount: 0,
            },
          ],
          pinRefused: false,
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a reply without the processor reading", () => {
    const { processor: _processor, ...withoutProcessor } = STATUS;
    expect(DaemonStatusReadResponseSchema.safeParse(withoutProcessor).success).toBe(false);
  });

  it("refuses a processor share above the whole machine", () => {
    expect(
      DaemonStatusReadResponseSchema.safeParse({
        ...STATUS,
        processor: { percent: 140, readAt: READ_AT },
      }).success,
    ).toBe(false);
  });

  it("refuses an approval-rules source out of its set", () => {
    expect(
      DaemonStatusReadResponseSchema.safeParse({
        ...STATUS,
        approvalRules: { ...STATUS.approvalRules, source: "download" },
      }).success,
    ).toBe(false);
  });

  it("refuses a member the reply does not define", () => {
    expect(DaemonStatusReadResponseSchema.safeParse({ ...STATUS, pid: 4242 }).success).toBe(false);
  });
});

describe("daemon.crashList's reply", () => {
  const REPORT = {
    crashedAt: "2026-09-29T03:12:00.000Z",
    processType: "renderer",
    appVersion: "1.4.0",
    serviceVersion: "1.4.0",
    platform: "darwin arm64 15.0",
    stack: [{ module: "libGLESv2.dylib", offset: 0x1a2f }],
  };

  it("accepts a stripped report", () => {
    expect(DaemonCrashListResponseSchema.safeParse({ reports: [REPORT] }).success).toBe(true);
  });

  it("refuses a frame that names a path rather than a file", () => {
    expect(
      DaemonCrashListResponseSchema.safeParse({
        reports: [
          { ...REPORT, stack: [{ module: "/Users/person/lib/libGLESv2.dylib", offset: 1 }] },
        ],
      }).success,
    ).toBe(false);
  });
});
