// The facts main reads for the bridge's `app` namespace: the build, the machine, and the region
// and the 12- or 24-hour clock the machine itself is set to, read at start and again each time
// macOS says they changed. The UI language `app.getLocale()` carries neither: Chromium formats in
// it, so a page left to `Intl`'s default writes a US English clock on a Mac set to 24-hour time or
// to the United Kingdom.

import { totalmem } from "node:os";

import { app, systemPreferences } from "electron";

import {
  canonicalLocale,
  supportedArch,
  supportedPlatform,
  type AppFacts,
  type HourCycle,
  type MachineClock,
} from "#shared/app-facts.js";

/**
 * The app's facts, read from Electron and the machine; call it after ready, when the locales are
 * known. Throws a `RangeError` for an unsupported platform or architecture, or a region or clock
 * the machine reports in a form no locale has, so a launch never hands a page an unchecked value.
 */
export function readAppFacts(): AppFacts {
  return {
    version: app.getVersion(),
    platform: supportedPlatform(process.platform),
    arch: supportedArch(process.arch),
    locale: app.getLocale(),
    physicalMemoryBytes: totalmem(),
    ...readMachineClock(),
  };
}

/**
 * The machine's region and clock as they stand now. Throws a `RangeError` for a region or clock
 * the machine reports in a form no locale has.
 */
export function readMachineClock(): MachineClock {
  // Electron keeps the system locale it read at start, so on macOS only its language is taken
  // from it: a language change relaunches a Mac app, while the region and the clock are read
  // fresh. The tag drops the ICU keywords macOS writes after an `@`, which no BCP 47 tag carries.
  const [tag = ""] = app.getSystemLocale().split("@");
  const systemLocale = canonicalLocale(tag);
  if (supportedPlatform(process.platform) !== "darwin") {
    return { regionLocale: systemLocale, hourCycle: regionHourCycle(systemLocale) };
  }
  // The country code is the region macOS formats in, which the Region setting can name apart from
  // the tag's own (`en_US@rg=gbzzzz` formats as the United Kingdom).
  const countryCode = app.getLocaleCountryCode();
  const regionLocale =
    countryCode === ""
      ? systemLocale
      : new Intl.Locale(systemLocale, { region: countryCode }).toString();
  const [, keywords = ""] = systemPreferences
    .getUserDefault(APPLE_LOCALE_DEFAULT, "string")
    .split("@");
  return { regionLocale, hourCycle: macHourCycle(keywords) ?? regionHourCycle(regionLocale) };
}

/**
 * Hands `announce` the machine's region and clock each time macOS posts that the person's locale
 * settings changed, for the life of main. Windows and Linux post main no such notice here.
 */
export function watchMachineClock(announce: (clock: MachineClock) => void): void {
  if (process.platform !== "darwin") {
    return;
  }
  systemPreferences.subscribeLocalNotification(LOCALE_CHANGE_NOTIFICATION, () => {
    announce(readMachineClock());
  });
}

/** The name Foundation posts `NSCurrentLocaleDidChangeNotification` under. */
const LOCALE_CHANGE_NOTIFICATION = "kCFLocaleCurrentLocaleDidChangeNotification";

/** The global default that holds the person's region, with its ICU keywords after an `@`. */
const APPLE_LOCALE_DEFAULT = "AppleLocale";

/** The ICU keyword in a macOS locale identifier that names the person's 12- or 24-hour choice. */
const HOURS_KEYWORD = "hours";

/** The global defaults Foundation reads as the 12- or 24-hour override after the keyword. */
const FORCE_24_HOUR_DEFAULT = "AppleICUForce24HourTime";
const FORCE_12_HOUR_DEFAULT = "AppleICUForce12HourTime";

/** The clock the person chose on macOS, or `undefined` where they left the region's own. */
function macHourCycle(keywords: string): HourCycle | undefined {
  const hours = keywords
    .split(";")
    .map((keyword) => keyword.split("="))
    .find(([key]) => key === HOURS_KEYWORD)?.[1];
  if (hours !== undefined) {
    return twelveOrTwentyFourHour(hours);
  }
  if (systemPreferences.getUserDefault(FORCE_24_HOUR_DEFAULT, "boolean")) {
    return "h23";
  }
  if (systemPreferences.getUserDefault(FORCE_12_HOUR_DEFAULT, "boolean")) {
    return "h12";
  }
  return undefined;
}

/** The clock `locale`'s region uses, as `Intl` resolves it. */
function regionHourCycle(locale: string): HourCycle {
  const { hourCycle } = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
  return twelveOrTwentyFourHour(hourCycle ?? "");
}

/**
 * One of the two clocks for an `Intl` hour cycle. The midnight-at-zero 12-hour cycle and the
 * midnight-at-24 one fold into the 12- and 24-hour clocks they are; anything else throws.
 */
function twelveOrTwentyFourHour(hourCycle: string): HourCycle {
  switch (hourCycle) {
    case "h11":
    case "h12":
      return "h12";
    case "h23":
    case "h24":
      return "h23";
    default:
      throw new RangeError(
        `The machine reports ${hourCycle} as its clock, which is no hour cycle.`,
      );
  }
}
