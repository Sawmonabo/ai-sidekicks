// The two sidebar sections this family fills, and the one holder they share.
//
// The sidebar is the composer family's and the section bodies are ours; the seat is
// what lets both land without either editing the other's file. This module is the
// only place the collaboration family calls `registerSidebarSection`.
//
// ONE HOLDER, CAPTURED BY BOTH DESCRIPTORS. The channels section and the members
// section read one session's models, so the holder is built here — once per
// registration call — and closed over by both renderers. It is not a module-level
// value: a second window composing this family gets its own, which is the same
// reason `registerConsoleFamilies` takes a registry rather than reaching for one.
//
// A `.ts` MODULE THAT BUILDS ELEMENTS. It owns a TABLE — which sections this family
// claims and what mounts in each — rather than a view, so it takes `createElement`
// instead of JSX, the shape `frame/legacy-surfaces.ts` already uses for the same
// reason.

import { createElement } from "react";

import { registerSidebarSection } from "../seats/index.js";
import { ChannelsSection } from "./ChannelsSection.js";
import { MembersSection } from "./MembersSection.js";
import { CollaborationSessionModelHolder } from "./session-models.js";

/** The owner string both sections register under. */
const COLLABORATION_SECTION_OWNER = "collaboration-sections";

/**
 * Fill the channels and members sections.
 *
 * Idempotent by the registry's own owner-scoped policy: a second call under this
 * owner replaces rather than conflicting. Each call builds a fresh holder and the
 * one shipped caller calls this once, so no second holder is ever live; a caller
 * that wanted to re-register a running console would have to release the first
 * holder itself, and nothing in the console does.
 */
export function registerCollaborationSections(): void {
  const holder = new CollaborationSessionModelHolder();

  registerSidebarSection({
    id: "channels",
    owner: COLLABORATION_SECTION_OWNER,
    render: (context) => createElement(ChannelsSection, { context, holder }),
  });

  registerSidebarSection({
    id: "members",
    owner: COLLABORATION_SECTION_OWNER,
    render: (context) => createElement(MembersSection, { context, holder }),
  });
}
