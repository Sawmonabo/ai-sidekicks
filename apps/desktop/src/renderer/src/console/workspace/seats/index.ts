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
//
// THE `@consumedBy` TAGS BELOW are the dead-code gate's one exemption, on the terms
// `apps/desktop/AGENTS.md` sets: every seat is reached by a task that has not landed,
// so each specifier names the task or tasks that will import it. The tag rides the
// SPECIFIER because that is the export knip reports; the declaration in the seat's own
// module carries the same claim as a `// Consumed by` line. Both go in the PR that
// imports the symbol — a tag that outlives its consumer fails the run.

export {
  /** @consumedBy T-023p-1C-2 */
  PANE_KINDS,
  /** @consumedBy T-023p-1C-2 */
  isPaneKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type PaneKind,
} from "./pane-kinds.js";

export {
  ConsolePaneRegistry,
  consolePaneRegistry,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  registerConsolePane,
  /** @consumedBy T-023p-1C-2, T-023p-1C-8 */
  registeredPaneKinds,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ConsolePaneAddress,
  type ConsolePaneContext,
  type ConsolePaneDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ConsolePaneOpener,
} from "./pane-registry.js";

export {
  /** @consumedBy T-023p-1C-2 */
  composerSeatRenderer,
  /** @consumedBy T-023p-1C-3 */
  registerComposerSeat,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  unregisterComposerSeat,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ComposerSeatProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ComposerSeatRenderer,
} from "./composer-seat.js";

export {
  /** @consumedBy T-023p-1C-3 */
  SIDEBAR_SECTION_IDS,
  /** @consumedBy T-023p-1C-3 */
  SidebarSectionRegistry,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5 */
  registerSidebarSection,
  /** @consumedBy T-023p-1C-3 */
  sidebarSectionRegistry,
  /** @consumedBy T-023p-1C-3 */
  sidebarSectionRenderer,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5 */
  type SidebarSectionContext,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5 */
  type SidebarSectionDescriptor,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5 */
  type SidebarSectionId,
} from "./sidebar-sections.js";

export {
  /** @consumedBy T-023p-1C-2 */
  TIMELINE_ROW_DENSITIES,
  /** @consumedBy T-023p-1C-2 */
  registerTimelineRowRenderer,
  /** @consumedBy T-023p-1C-2 */
  timelineRowRenderer,
  /** @consumedBy T-023p-1C-2 */
  unregisterTimelineRowRenderer,
  /** @consumedBy T-023p-1C-2 */
  type TimelineRowDensity,
  /** @consumedBy T-023p-1C-2 */
  type TimelineRowRenderer,
  /** @consumedBy T-023p-1C-2 */
  type TimelineRowSlotProps,
} from "./timeline-row-slot.js";

export {
  /** @consumedBy T-023p-1C-2 */
  INLINE_CARD_KINDS,
  /** @consumedBy T-023p-1C-2 */
  InlineCardSeatRegistry,
  /** @consumedBy T-023p-1C-2 */
  inlineCardBody,
  /** @consumedBy T-023p-1C-2 */
  inlineCardSeatRegistry,
  /** @consumedBy T-023p-1C-5 */
  registerInlineCardBody,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type ArtifactInlineCardProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type AttachmentInlineCardProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type DiffInlineCardProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type InlineCardAttachmentRef,
  /** @consumedBy T-023p-1C-5 */
  type InlineCardBodyDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type InlineCardKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type InlineCardPropsByKind,
  /** @consumedBy T-023p-1C-2 */
  type InlineCardSeatProps,
} from "./inline-card-seats.js";

export type { OwnerSlotContract, OwnerSlotProps } from "./owner-slot.js";
