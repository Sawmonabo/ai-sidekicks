// The machine's region and 12- or 24-hour clock, which every clock figure and date on every page is
// written in, never the UI language: `app.getLocale()` carries neither, and Chromium formats in
// it, so a page left to `Intl`'s default writes a US English clock on a machine set to 24-hour
// time. Each platform reads them from its own place behind `MachineClockReader`; `platform.ts`
// picks the reader. This file holds the interface and the reader for a platform whose system
// locale carries both; a platform that keeps them elsewhere reads them in its own file.

import { app } from "electron";

import { canonicalLocale, type HourCycle, type MachineClock } from "#shared/app-facts.js";
import type { MainDiagnosticLog } from "../../services/diagnostic-log.js";

/** Where one platform reads the machine's region and clock, and how it hears them change. */
export interface MachineClockReader {
  /**
   * The machine's region and clock as they stand now. Throws a `RangeError` for a region or clock
   * the machine reports in a form no locale has.
   */
  read(): MachineClock;
  /**
   * Hands `announce` the region and clock each time the platform says they changed, for the life
   * of main; a change that cannot be read is logged as an error and never announced. Absent on a
   * platform that posts main no such notice.
   */
  readonly watch?: (
    announce: (clock: MachineClock) => void,
    log: Pick<MainDiagnosticLog, "write">,
  ) => void;
}

/**
 * The reader for a platform whose region is its system locale and whose clock is that region's
 * own, with no change notice to hear.
 */
export class SystemLocaleClockReader implements MachineClockReader {
  public read(): MachineClock {
    const regionLocale = readSystemLocale();
    return { regionLocale, hourCycle: regionHourCycle(regionLocale) };
  }
}

/**
 * The system locale as a canonical BCP 47 tag, without the ICU keywords a platform may write
 * after an `@`, which no tag carries. Throws a `RangeError` for a locale no tag names.
 */
export function readSystemLocale(): string {
  const [tag = ""] = app.getSystemLocale().split("@");
  return canonicalLocale(tag);
}

/** The clock `locale`'s region uses, as `Intl` resolves it. */
export function regionHourCycle(locale: string): HourCycle {
  const { hourCycle } = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
  return twelveOrTwentyFourHour(hourCycle ?? "");
}

/**
 * One of the two clocks for an `Intl` hour cycle. The midnight-at-zero 12-hour cycle and the
 * midnight-at-24 one fold into the 12- and 24-hour clocks they are; anything else throws a
 * `RangeError`.
 */
export function twelveOrTwentyFourHour(hourCycle: string): HourCycle {
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
