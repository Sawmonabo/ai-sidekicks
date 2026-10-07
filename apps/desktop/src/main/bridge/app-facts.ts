// The facts main reads once, after ready, for the bridge's `app` namespace: the build, the
// machine, and the region and the 12- or 24-hour clock the machine itself is set to. The UI
// language `app.getLocale()` carries neither: Chromium formats in it, so a page left to `Intl`'s
// default writes a US English clock on a Mac set to 24-hour time or to the United Kingdom.

import { totalmem } from "node:os";

import { app, systemPreferences } from "electron";

import {
  canonicalLocale,
  supportedArch,
  supportedPlatform,
  type AppFacts,
  type HourCycle,
  type SupportedPlatform,
} from "#shared/app-facts.js";

/**
 * The app's facts, read from Electron and the machine; call it after ready, when the locales are
 * known. Throws a `RangeError` for an unsupported platform or architecture, or a region or clock
 * the machine reports in a form no locale has, so a launch never hands a page an unchecked value.
 */
export function readAppFacts(): AppFacts {
  const platform = supportedPlatform(process.platform);
  return {
    version: app.getVersion(),
    platform,
    arch: supportedArch(process.arch),
    locale: app.getLocale(),
    physicalMemoryBytes: totalmem(),
    ...readMachineClock(platform),
  };
}

/** The ICU keyword in a macOS locale identifier that names the person's 12- or 24-hour choice. */
const HOURS_KEYWORD = "hours";

/** The global defaults macOS keeps the 24-Hour Time switch in where it differs from the region. */
const FORCE_24_HOUR_DEFAULT = "AppleICUForce24HourTime";
const FORCE_12_HOUR_DEFAULT = "AppleICUForce12HourTime";

function readMachineClock(
  platform: SupportedPlatform,
): Pick<AppFacts, "regionLocale" | "hourCycle"> {
  // macOS answers `[NSLocale currentLocale]`'s identifier, whose ICU keywords follow an `@`
  // (`en-US@hours=h23`, `en-US@rg=gbzzzz`); Windows and Linux answer a plain tag.
  const [tag = "", keywords = ""] = app.getSystemLocale().split("@");
  const systemLocale = canonicalLocale(tag);
  if (platform !== "darwin") {
    return { regionLocale: systemLocale, hourCycle: regionHourCycle(systemLocale) };
  }
  // The Region setting can name a region other than the tag's own (`@rg=`); the country code is
  // the region macOS formats in, so the person's language is kept with the region's conventions.
  const countryCode = app.getLocaleCountryCode();
  const regionLocale =
    countryCode === ""
      ? systemLocale
      : new Intl.Locale(systemLocale, { region: countryCode }).toString();
  return { regionLocale, hourCycle: macHourCycle(keywords) ?? regionHourCycle(regionLocale) };
}

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
