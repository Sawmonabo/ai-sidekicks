// A page whose body a composition supplies: the page frame, and the body registered for the page
// mounted inside it. A fixture launch registers the Providers and MCP servers bodies, and the
// Remote Control feature the Devices one; with nothing registered the frame stays empty, as the
// pages not built yet draw it.

import type { ReactNode } from "react";

import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { findSettingsPageBody } from "./body-registry.js";

/** The frame of the page `pageId`, holding the body registered for it, if one is. */
export function RegisteredBodyPage(props: { readonly pageId: SettingsPageId }): ReactNode {
  const Body = findSettingsPageBody(props.pageId);
  return <div className="meridian-settings-page">{Body === undefined ? null : <Body />}</div>;
}
