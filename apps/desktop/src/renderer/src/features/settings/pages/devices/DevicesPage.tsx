// The Devices page: the frame, and the body a composition registered for it. The Remote Control
// feature registers that body; with nothing registered the frame stays empty.

import type { ReactNode } from "react";

import { findSettingsPageBody } from "../body-registry.js";

/** The Devices page: the registered body under the page heading. */
export function DevicesPage(): ReactNode {
  const Body = findSettingsPageBody("devices");
  return <div className="meridian-settings-page">{Body === undefined ? null : <Body />}</div>;
}
