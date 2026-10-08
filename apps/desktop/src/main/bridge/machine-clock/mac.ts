// The machine's region and clock on macOS, read at start and again each time macOS says the
// person's locale settings changed.

import { app, systemPreferences } from "electron";

import type { HourCycle, MachineClock } from "#shared/app-facts.js";
import { describeFailure } from "#shared/failure-message.js";
import type { MainDiagnosticLog } from "../../services/diagnostic-log.js";
import {
  readSystemLocale,
  regionHourCycle,
  twelveOrTwentyFourHour,
  type MachineClockReader,
} from "./reader.js";

/** The macOS reader: the Region setting's country and the 24-Hour Time choice. */
export class MacMachineClockReader implements MachineClockReader {
  public read(): MachineClock {
    // Electron keeps the system locale it read at start, so only its language is taken from it:
    // a language change relaunches a Mac app, while the region and the clock are read fresh.
    const systemLocale = readSystemLocale();
    // The country code is the region macOS formats in, which the Region setting can name apart
    // from the tag's own (`en_US@rg=gbzzzz` formats as the United Kingdom).
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

  public watch(
    announce: (clock: MachineClock) => void,
    log: Pick<MainDiagnosticLog, "write">,
  ): void {
    systemPreferences.subscribeLocalNotification(LOCALE_CHANGE_NOTIFICATION, () => {
      let clock: MachineClock;
      try {
        clock = this.read();
      } catch (failure) {
        log.write({
          level: "error",
          source: LOG_SOURCE,
          message: `the machine's changed region or clock was not read: ${describeFailure(failure)}`,
        });
        return;
      }
      announce(clock);
    });
  }
}

const LOG_SOURCE = "main/bridge/machine-clock/mac";

/** The name Foundation posts `NSCurrentLocaleDidChangeNotification` under. */
const LOCALE_CHANGE_NOTIFICATION = "kCFLocaleCurrentLocaleDidChangeNotification";

/** The global default that holds the person's region, with its ICU keywords after an `@`. */
const APPLE_LOCALE_DEFAULT = "AppleLocale";

/** The ICU keyword in a macOS locale identifier that names the person's 12- or 24-hour choice. */
const HOURS_KEYWORD = "hours";

/**
 * The global defaults System Settings' 24-Hour Time switch writes, which Foundation reads as the
 * 12- or 24-hour override after the keyword.
 */
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
