// The browser's page in settings: the sections the caller composes under the pane's heading.
//
// It is registered as the `browser` section in `features/settings/pages/registry.ts`; the settings
// pane draws its heading, so the page draws none of its own. The page is a projection: everything
// it draws arrives as children, and it fetches nothing, holds no store and runs no effect, so it
// renders the same in a test and the app.

import "./BrowserPage.css";

import type { ReactNode } from "react";

/** The browser settings page: whatever section the caller composes under the pane's heading. */
export function BrowserPage(props: { readonly children?: ReactNode }): React.JSX.Element {
  return <section className="meridian-browser-settings">{props.children}</section>;
}
