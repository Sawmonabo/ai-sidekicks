// The browser's page in settings: its heading, and the sections the caller composes under
// it.
//
// It is mounted on the settings board as the `browser` section. The settings screen is
// one registered screen, so the pages behind it are keyed by section in a registry of their
// own. The one line that registers this page lives at the console root, in
// `console/browser-settings-page.ts`, because the registration names two features
// and neither feature may import the other.
//
// The page is a projection, not a read: everything it draws arrives as children, and it
// performs no fetch, holds no store, and runs no effect. That keeps it renderable in a
// test, in a screenshot tier, and in an auxiliary window without a second code path.

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
