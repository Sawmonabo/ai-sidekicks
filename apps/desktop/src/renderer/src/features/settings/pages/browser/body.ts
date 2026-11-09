// The browser settings page's body, and the root of the chunk it arrives in.
//
// Loader-backed so the page stays off the initial import graph. The body binds this window's
// machine settings and clock and hands them to the page.

import { createElement } from "react";

import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useMachineSettings } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import type { SettingsPageContext } from "../../types.js";
import { BrowserPage } from "./BrowserPage.js";

/** The Browser page, as the settings page registry loads it. */
export function Body(context: SettingsPageContext): React.ReactNode {
  const preferences = useMachineSettings(context.bridge);
  const clock = useClock();
  return createElement(BrowserPage, { preferences, clock });
}
