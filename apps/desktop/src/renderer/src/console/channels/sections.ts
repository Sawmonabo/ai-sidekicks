// The sidebar section this family fills, and the holder it reads through.
//
// The sidebar is the composer family's and the section body is ours; the seat is
// what lets both land without either editing the other's file. This module is the
// only place the collaboration family writes to the sidebar board, and it writes to
// the board it is HANDED — never to the module-scope singleton beside it, which is
// the running console's whatever a caller composed.
//
// ONE HOLDER, BUILT HERE. The section reads one session's models, so the holder is
// built here — once per registration call — and closed over by the renderer. It is
// not a module-level value: a second window composing this family gets its own,
// which is the same reason `registerConsoleFamilies` takes a registry rather than
// reaching for one.
//
// A `.ts` MODULE THAT BUILDS ELEMENTS. It owns a TABLE — which sections this family
// claims and what mounts in each — rather than a view, so it takes `createElement`
// instead of JSX, the shape `seats/surface/absorbed-surfaces.ts` already uses for the same
// reason.

import { createElement } from "react";

import type { SidebarSectionRegistry } from "../seats/index.js";
import { ChannelsSection } from "./ChannelsSection.js";
import { CollaborationSessionModelHolder } from "./session-models.js";

/** The owner string the section registers under. */
const COLLABORATION_SECTION_OWNER = "collaboration-sections";

/**
 * Fill the channels section.
 *
 * Idempotent by the registry's own owner-scoped policy: a second call under this
 * owner replaces rather than conflicting. Each call builds a fresh holder and the
 * one shipped caller calls this once, so no second holder is ever live; a caller
 * that wanted to re-register a running console would have to release the first
 * holder itself, and nothing in the console does.
 */
export function registerChannelsSections(sections: SidebarSectionRegistry): void {
  const holder = new CollaborationSessionModelHolder();

  sections.register({
    id: "channels",
    owner: COLLABORATION_SECTION_OWNER,
    render: (context) => createElement(ChannelsSection, { context, holder }),
  });
}
