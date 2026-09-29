// The browser settings page's body, and the root of the chunk it arrives in.
//
// A LOADER-BACKED BODY, so the page and its policy rows are not on the initial import
// graph: a person navigates to settings and then chooses a section, which is two acts
// after the first paint. the preview feature's public entry is imported eagerly by `app/registrations.ts`, so
// the page has to be reached through a module the eager graph does not, which is this
// one. The page's sheet enters here.

import "./settings.css";

import { createElement } from "react";

import { BrowserSettingsSection } from "./BrowserSettingsSection.js";

/** The browser section of settings, as the settings board loads it. */
export function Body(): React.ReactNode {
  return createElement(BrowserSettingsSection);
}
