// `service.json` is written by the desktop app and the Windows command line and
// read by both and by the service's Windows-side helper before any service runs.
import { describe, expect, it } from "vitest";

import { ServiceRecordSchema } from "../service-place.js";

const wslRecord = {
  place: { distro: "Ubuntu" },
  runtimeVersion: "0.1.0",
  runtimeDigest: "b".repeat(64),
  distroHome: "/home/me",
};

describe("ServiceRecordSchema", () => {
  it("accepts a service on Windows and a service in a WSL distribution", () => {
    expect(ServiceRecordSchema.safeParse({ place: "windows" }).success).toBe(true);
    expect(ServiceRecordSchema.safeParse(wslRecord).success).toBe(true);
  });

  it.each([
    ["a WSL record missing its runtime digest", { runtimeDigest: undefined }],
    ["a runtime digest that is not 64 lowercase hex digits", { runtimeDigest: "B".repeat(64) }],
    ["an empty distribution name", { place: { distro: "" } }],
    ["an unknown member", { mutexName: "service" }],
  ])("refuses %s", (_case, change) => {
    expect(ServiceRecordSchema.safeParse({ ...wslRecord, ...change }).success).toBe(false);
  });

  it("refuses a Windows record carrying a distribution's runtime", () => {
    expect(ServiceRecordSchema.safeParse({ ...wslRecord, place: "windows" }).success).toBe(false);
  });
});
