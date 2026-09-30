// The facts main hands a window reach the preload intact; an unsupported platform,
// architecture or memory figure never does.

import { describe, expect, it } from "vitest";

import {
  appFactsSwitches,
  readAppFactsSwitches,
  supportedArch,
  supportedPlatform,
  type AppFacts,
} from "./app-facts.js";

const FACTS: AppFacts = {
  version: "1.4.0-beta.2+build=7",
  platform: "linux",
  arch: "x64",
  locale: "sr-Latn-RS",
  physicalMemoryBytes: 17_179_869_184,
};

describe("the app facts a window is started with", () => {
  it("reads back what main wrote, among the other switches a window carries", () => {
    const argv = [
      "/path/to/electron",
      "--type=renderer",
      ...appFactsSwitches(FACTS),
      "--no-sandbox",
    ];

    expect(readAppFactsSwitches(argv)).toStrictEqual(FACTS);
  });

  it("refuses a window started without the facts", () => {
    expect(() => readAppFactsSwitches(["--type=renderer"])).toThrow(RangeError);
  });

  it("refuses a memory figure that is not a positive whole number of bytes", () => {
    for (const physicalMemoryBytes of [0, -1, 1.5, Number.NaN]) {
      const argv = appFactsSwitches({ ...FACTS, physicalMemoryBytes });
      expect(() => readAppFactsSwitches(argv)).toThrow(RangeError);
    }
  });

  it("refuses a platform or architecture outside the supported matrix", () => {
    expect(() => supportedPlatform("freebsd")).toThrow(RangeError);
    expect(() => supportedArch("ia32")).toThrow(RangeError);
    expect(supportedPlatform("win32")).toBe("win32");
    expect(supportedArch("arm64")).toBe("arm64");

    const argv = appFactsSwitches(FACTS).map((argument) =>
      argument.replace("--sidekicks-app-platform=linux", "--sidekicks-app-platform=aix"),
    );
    expect(() => readAppFactsSwitches(argv)).toThrow(RangeError);
  });
});
