import { useMemo } from "react";

import { clockLocaleFor } from "#renderer/lib/wire/figures.js";
import { usePlatformBridge } from "./usePlatformBridge.js";

/**
 * The locale every clock figure and date on screen is written in, from the region and the 12- or
 * 24-hour clock main read off the machine; the tag to pass as a clock or date formatter's locale.
 */
export function useClockLocale(): string {
  const { app } = usePlatformBridge();
  return useMemo(() => clockLocaleFor(app), [app]);
}
