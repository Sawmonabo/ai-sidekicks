// The browser's page in settings: its heading and the sections the caller composes under it.
//
// It is registered as the `browser` section in `settings-pages.ts`. The page is a projection:
// everything it draws arrives as children, and it fetches nothing, holds no store and runs no
// effect, so it renders the same in a test, a screenshot tier and the app.

import type { ReactNode } from "react";

/** The browser settings page: its heading, and whatever section the caller composes under it. */
export function BrowserPage(props: { readonly children?: ReactNode }): React.JSX.Element {
  return (
    <section
      className="meridian-browser-settings"
      aria-labelledby="meridian-browser-settings-title"
    >
      <header>
        <h2 className="meridian-browser-settings__title" id="meridian-browser-settings-title">
          Browser
        </h2>
      </header>
      {props.children}
    </section>
  );
}
