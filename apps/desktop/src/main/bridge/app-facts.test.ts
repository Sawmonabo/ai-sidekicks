// Main reads the region and the 12- or 24-hour clock from where each platform keeps them, never
// from the UI language, and refuses a clock no locale has rather than handing a page a guess.

import { afterEach, describe, expect, it, vi } from "vitest";

import { readAppFacts } from "./app-facts.js";

/** What the machine under test reports, set by each case. */
const machine = vi.hoisted(() => ({
  systemLocale: "en-US",
  countryCode: "US",
  userDefaults: new Map<string, string | boolean>(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0",
    getLocale: () => "en-US",
    getSystemLocale: () => machine.systemLocale,
    getLocaleCountryCode: () => machine.countryCode,
  },
  systemPreferences: {
    // An unset default reads as Electron hands it back: empty, or false.
    getUserDefault: (key: string, type: "string" | "boolean") =>
      machine.userDefaults.get(key) ?? (type === "string" ? "" : false),
  },
}));

const HOST_PLATFORM = process.platform;

/** Stands the read on `platform` with what that machine reports. */
function standOn(
  platform: NodeJS.Platform,
  reported: {
    readonly systemLocale: string;
    readonly countryCode: string;
    readonly userDefaults?: Readonly<Record<string, string | boolean>>;
  },
): void {
  Object.defineProperty(process, "platform", { value: platform });
  machine.systemLocale = reported.systemLocale;
  machine.countryCode = reported.countryCode;
  machine.userDefaults = new Map(Object.entries(reported.userDefaults ?? {}));
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: HOST_PLATFORM });
});

describe("the machine's clock and region main reads", () => {
  it.each([
    {
      machineSays: "a US Mac with 24-Hour Time on, in the locale's keyword",
      platform: "darwin",
      reported: {
        systemLocale: "en-US@hours=h23",
        countryCode: "US",
        userDefaults: { AppleLocale: "en_US@hours=h23" },
      },
      expected: { regionLocale: "en-US", hourCycle: "h23" },
    },
    {
      machineSays: "a US Mac with 24-Hour Time on, in the global default",
      platform: "darwin",
      reported: {
        systemLocale: "en-US",
        countryCode: "US",
        userDefaults: { AppleICUForce24HourTime: true },
      },
      expected: { regionLocale: "en-US", hourCycle: "h23" },
    },
    {
      machineSays: "a UK Mac with 24-Hour Time off",
      platform: "darwin",
      reported: {
        systemLocale: "en-GB",
        countryCode: "GB",
        userDefaults: { AppleICUForce12HourTime: true },
      },
      expected: { regionLocale: "en-GB", hourCycle: "h12" },
    },
    {
      machineSays: "a Mac in English with the United Kingdom as its region",
      platform: "darwin",
      reported: {
        systemLocale: "en-US@rg=gbzzzz",
        countryCode: "GB",
        userDefaults: { AppleLocale: "en_US@rg=gbzzzz" },
      },
      expected: { regionLocale: "en-GB", hourCycle: "h23" },
    },
    {
      machineSays: "a US Mac left at its region's clock",
      platform: "darwin",
      reported: { systemLocale: "en-US", countryCode: "US" },
      expected: { regionLocale: "en-US", hourCycle: "h12" },
    },
    {
      machineSays: "a German Linux machine",
      platform: "linux",
      reported: { systemLocale: "de-DE", countryCode: "DE" },
      expected: { regionLocale: "de-DE", hourCycle: "h23" },
    },
  ] as const)("reads $expected.hourCycle for $machineSays", ({ platform, reported, expected }) => {
    standOn(platform, reported);

    const facts = readAppFacts();

    expect(facts.locale).toBe("en-US");
    expect({ regionLocale: facts.regionLocale, hourCycle: facts.hourCycle }).toStrictEqual(
      expected,
    );
  });

  it("refuses a clock keyword that names no hour cycle", () => {
    standOn("darwin", {
      systemLocale: "en-US@hours=h25",
      countryCode: "US",
      userDefaults: { AppleLocale: "en_US@hours=h25" },
    });

    expect(() => readAppFacts()).toThrow(RangeError);
  });
});
