// Where a settings page gets a body a composition supplies. The page draws the frame and mounts
// what was registered for its section, so the page imports no body and a composition that has
// none leaves the frame empty.

import type { ReactNode } from "react";

import { KeyedRegistry } from "@renderer/lib/keyed-registry.js";
import { type SingleEntryDescriptor } from "@renderer/lib/single-entry-registry.js";
import { type SettingsPageId } from "@renderer/routing/settings-page-ids.js";

/** A body a composition supplies for one settings page. */
export type SettingsPageBody = () => ReactNode;

const pageBodiesBySection = new KeyedRegistry<
  SettingsPageId,
  SingleEntryDescriptor<SettingsPageBody>
>({
  duplicatePolicy: "owner-scoped",
  describeWhat: "settings page body",
  ownerOf: (descriptor) => descriptor.owner,
  duplicateHint:
    "a page mounts one body; a second owner would make which one renders depend on composition order",
});

/** Fill a page's body. A second owner is refused; the same owner replaces its body. */
export function registerSettingsPageBody(
  section: SettingsPageId,
  owner: string,
  body: SettingsPageBody,
): void {
  pageBodiesBySection.register(section, { owner, render: body });
}

/** The body registered for a page, or `undefined` while none is. */
export function findSettingsPageBody(section: SettingsPageId): SettingsPageBody | undefined {
  return pageBodiesBySection.get(section)?.render;
}
