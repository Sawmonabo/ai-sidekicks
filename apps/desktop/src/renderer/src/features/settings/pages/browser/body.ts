// The browser settings page's body, and the root of the chunk it arrives in.
//
// Loader-backed so the page, its policy rows and their sheets stay off the initial import graph.

import { createElement } from "react";

import { BrowserPage } from "./BrowserPage.js";

/** The Browser page, as the settings page registry loads it. */
export function Body(): React.ReactNode {
  return createElement(BrowserPage);
}
