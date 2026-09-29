// The Providers page: an empty frame under the page heading.
//
// The account list and the sign-in flow are `fixtures/AccountsFixtureBody.tsx`, which takes
// its calls as arguments; nothing mounts it until a composition has calls to give.

import type { ReactNode } from "react";

/** The Providers page: an empty frame under the page heading. */
export function ProvidersPage(): ReactNode {
  return <div className="meridian-settings-page" />;
}
