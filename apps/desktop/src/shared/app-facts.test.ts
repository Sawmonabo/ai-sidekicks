// The facts main hands a window reach the preload intact, and a window started without them
// is refused.

import { describe, expect, it } from "vitest";

import { appFactsSwitches, readAppFactsSwitches, type AppFacts } from "./app-facts.js";

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
});
