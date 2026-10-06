// The browser settings page's body, and the root of the chunk it arrives in.
//
// Loader-backed so the page, its policy rows and their sheets stay off the initial import graph.

import { createElement } from "react";

import { BrowserSettingsSection } from "./BrowserSettingsSection.js";

/** The browser section of settings, as the settings board loads it. */
export function Body(): React.ReactNode {
  return createElement(BrowserSettingsSection);
}
