// The seats door — the one place view families may reach each other through.
//
// Every other cross-family edge in the console runs downward through the DAG:
// a view family imports `core/`, `tokens/`, `routing/`, `primitives/`, `store/`,
// `persistence/`, `bridge/`, `palette/`, and `frame/`, and none of those imports
// it back. The six view families are SIBLINGS, and siblings have no edge at all —
// which is what keeps six concurrent branches from serializing behind each other.
//
// But siblings still hand each other things: the deck mounts panes six families
// build, the workspace mounts a composer the composer family fills, one sidebar
// carries sections four families own, and the ledger renders cards the repos
// family authors. Every one of those is a CONTRACT rather than an import — a type
// plus a registry, minted once here so no branch invents its own.
//
// So the rule is: a view family imports this door and nothing else of a sibling's.
// A family reaching past it into another family's subtree is reaching for a body,
// and a body is exactly what a seat exists to keep it from holding.
//
// NOTHING HERE RENDERS. No component, no CSS, no store, no scenario. A seat that
// rendered would be a body, and the family that owns the body would then have two.

export { PANE_KINDS, isPaneKind, type PaneKind } from "./pane-kinds.js";

export {
  ConsolePaneRegistry,
  consolePaneRegistry,
  registerConsolePane,
  registeredPaneKinds,
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type ConsolePaneDescriptor,
  type ConsolePaneOpener,
} from "./pane-registry.js";

export {
  composerSeatRenderer,
  registerComposerSeat,
  unregisterComposerSeat,
  type ComposerSeatProps,
  type ComposerSeatRenderer,
} from "./composer-seat.js";

export {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  registerSidebarSection,
  sidebarSectionRegistry,
  sidebarSectionRenderer,
  type SidebarSectionContext,
  type SidebarSectionDescriptor,
  type SidebarSectionId,
} from "./sidebar-sections.js";

export {
  TIMELINE_ROW_DENSITIES,
  registerTimelineRowRenderer,
  timelineRowRenderer,
  unregisterTimelineRowRenderer,
  type TimelineRowDensity,
  type TimelineRowRenderer,
  type TimelineRowSlotProps,
} from "./timeline-row-slot.js";

export {
  INLINE_CARD_KINDS,
  InlineCardSeatRegistry,
  inlineCardBody,
  inlineCardSeatRegistry,
  registerInlineCardBody,
  type ArtifactInlineCardProps,
  type AttachmentInlineCardProps,
  type DiffInlineCardProps,
  type InlineCardAttachmentRef,
  type InlineCardBodyDescriptor,
  type InlineCardKind,
  type InlineCardPropsByKind,
  type InlineCardSeatProps,
} from "./inline-card-seats.js";

export type { OwnerSlotContract, OwnerSlotProps } from "./owner-slot.js";
