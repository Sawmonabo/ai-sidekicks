// A crash report's stack frames name each module's file and never its path, so a report never
// carries the person's folder names or user name off the machine.
import { describe, expect, it } from "vitest";

import { DaemonCrashListResponseSchema } from "../status.js";

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
