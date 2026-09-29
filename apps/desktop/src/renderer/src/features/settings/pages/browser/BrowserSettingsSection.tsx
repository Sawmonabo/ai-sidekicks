// The browser settings page frame, with no policy section composed under it.

import type { ReactNode } from "react";

import { BrowserSettingsPage } from "./BrowserPage.js";

/** The browser section of settings: the page heading alone. */
export function BrowserSettingsSection(): ReactNode {
  return <BrowserSettingsPage />;
}
