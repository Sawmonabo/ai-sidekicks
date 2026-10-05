// The Settings screen's body, and the root of the chunk it arrives in.
//
// Reached only by the screen registration's loader, so what it imports is paid for when a
// person opens Settings and never before. The two sheets below style the whole screen and
// every page frame, so this chunk root imports them; each component imports its own sheet.
//
// The page registry is composed per mount rather than at module scope: no second window
// inherits this one's pages, and a suite renders against a registry it owns.

import "./settings-screen.css";
import "./settings-page.css";

import { createElement, useState } from "react";

import type { ScreenContext } from "#renderer/registries/screens/screen-context.js";
import { composeSettingsPages } from "./settings-pages.js";
import { SettingsScreen } from "./SettingsScreen.js";

/**
 * The Settings screen, with its pages composed for this mount.
 *
 * `useState` with a lazy initializer, so the registry is built once per mount and never in
 * a render body.
 */
export function Body(context: ScreenContext): React.ReactNode {
  const [pages] = useState(composeSettingsPages);
  return createElement(SettingsScreen, { context, pages });
}
