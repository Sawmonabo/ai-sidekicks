// The Providers page: the frame, and the body a composition registered for it. A fixture launch
// registers `fixtures/AccountsFixtureMount.tsx`; with nothing registered the frame stays empty.

import type { ReactNode } from "react";

import { findSettingsPageBody } from "../page-body-registry.js";

/** The Providers page: the registered body under the page heading. */
export function ProvidersPage(): ReactNode {
  const Body = findSettingsPageBody("providers");
  return <div className="meridian-settings-page">{Body === undefined ? null : <Body />}</div>;
}
