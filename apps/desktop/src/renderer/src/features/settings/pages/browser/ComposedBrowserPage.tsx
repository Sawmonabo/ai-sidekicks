// The Browser page as the settings screen draws it: the page frame, with no policy section
// composed under it.

import type { ReactNode } from "react";

import { BrowserPage } from "./BrowserPage.js";

/** The Browser settings page: the empty page frame under the pane's heading. */
export function ComposedBrowserPage(): ReactNode {
  return <BrowserPage />;
}
