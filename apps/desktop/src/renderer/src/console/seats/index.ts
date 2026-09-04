// The seats family's door — and the one place view families reach each other.
//
// The family holds the session workspace's shared vocabulary: the seats through
// which the view families hand each other panes, a composer, sidebar sections,
// timeline rows, and inline cards. It sits directly above `bridge/` and below
// `palette/` and `frame/` in the console's DAG.
//
// WHY THAT POSITION, AND NOT INSIDE A VIEW FAMILY. These contracts used to live at
// `workspace/seats/` and were published by `workspace/index.ts`. `workspace/` is a
// VIEW FAMILY — the ledger and the composer author bodies in it — and a view family
// sits at the TOP of the DAG, above the frame. But the frame composes the pane
// registry singleton, so the frame imported the family, and the family is documented
// to import the frame: an upward edge that either closes a cycle the moment the
// workspace body lands, or forces a view family to stop using its own lower layers.
// The layering gate stayed green on it because its ladders stopped at `frame/` and
// no rule named the view families at all. Both halves are fixed together — this
// family is the hoist, and `.dependency-cruiser.mjs` now forbids any layer family,
// the frame included, from importing a view family.
//
// The position is read off the imports rather than chosen: the seats import `core/`,
// `tokens/`, `routing/`, `store/`, `persistence/`, `bridge/`, and `src/shared/`, and
// nothing higher, so the lowest home above all of them is the slot immediately above
// `bridge/`. Lower is also the more permissive choice for the two families that sit
// between here and the view families — the palette may open a pane, and the frame may
// hold the board — while neither can be reached from a seat.
//
// ONE BARREL. `apps/desktop/AGENTS.md` §Module shape: "Every console family carries
// exactly one `index.ts`. Cross-family imports go through it; intra-family imports
// are deep. A barrel re-exports only its own family — no re-export chains." This file
// is that one barrel, and the seat modules beside it are the family.
//
// WHY EVERY OTHER CROSS-FAMILY EDGE STILL RUNS DOWNWARD. A view family imports
// `core/`, `tokens/`, `routing/`, `primitives/`, `store/`, `persistence/`,
// `bridge/`, `seats/`, `palette/`, and `frame/`, and none of those imports it back.
// The view families are SIBLINGS, and siblings have no edge at all — which is what
// keeps six concurrent branches from serializing behind each other.
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
// NOTHING HERE RENDERS. No component, no CSS, no store, no scenario. A seat
// that rendered would be a body, and the family that owns the body would then have
// two.
//
// THE `@consumedBy` TAGS BELOW are the dead-code gate's one exemption, on the terms
// `apps/desktop/AGENTS.md` sets: every seat is reached by a task that has not landed,
// so each specifier names the task or tasks that will import it. The tag rides the
// SPECIFIER because that is the export knip reports; the declaration in the seat's own
// module carries the same claim as a `// Consumed by` line. Both go in the PR that
// imports the symbol — a tag that outlives its consumer fails the run.

export {
  /** @consumedBy T-023p-1C-2 */
  DETACHABLE_PANE_KINDS,
  /** @consumedBy T-023p-1C-2 */
  PANE_KINDS,
  /** @consumedBy T-023p-1C-2 */
  isDetachablePaneKind,
  /** @consumedBy T-023p-1C-2 */
  isPaneKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type PaneKind,
} from "./pane-kinds.js";

export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  paneEntityScopeFor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  parseConsolePaneAddress,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ConsolePaneAddress,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type PaneEntityScopeDeclaration,
} from "./pane-address.js";

export {
  ConsolePaneRegistry,
  consolePaneRegistry,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  registerConsolePane,
  /** @consumedBy T-023p-1C-2, T-023p-1C-8 */
  registeredPaneKinds,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type ConsolePaneContext,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-4, T-023p-1C-5, T-023p-1C-6, T-023p-1C-7 */
  type ConsolePaneDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ConsolePaneLink,
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
  registerSidebarSection,
  sidebarSectionRegistry,
  /** @consumedBy T-023p-1C-3 */
  sidebarSectionRenderer,
  type SidebarSectionContext,
  /** @consumedBy T-023p-1C-3, T-023p-1C-4, T-023p-1C-5 */
  type SidebarSectionDescriptor,
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

export type {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3, T-023p-1C-6 */
  OwnerSlotContract,
  OwnerSlotProps,
} from "./owner-slot.js";

// The read discipline every live wire read in this console follows — subscribe
// first, answer a push with a fresh read, one read per burst through the refresh
// chokepoint, never a flicker. It sits here rather than in the family that wrote it
// because four view families now hold one, and a second copy would be a second set
// of answers to when a surface re-reads.
// The failure-code vocabulary, the options shape, and the codes' derived union stay
// inside this family: their readers are the module itself and the suite beside it,
// and a barrel specifier no cross-family import uses is a dead export rather than a
// convenience.
export {
  PushDrivenRead,
  consoleRefusalFrom,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "./push-driven-read.js";

// What a session-scoped holder was built for, and whether it still is. Two view
// families hold one set of models each and both had written the same guard against
// the session id alone; siblings may not import each other, so the shared predicate
// lives at the lowest family above both.
export { isCurrentSessionSubject, type SessionSubject } from "./session-subject.js";

// The console's single copy of the daemon-method cast, for the same reason: the
// brand `SidekicksBridge.daemon.call` takes is `never`-shaped until Plan-007 narrows
// it, and every caller casts. One module casts, and the day the brand narrows one
// file changes.
export { callDaemonMethod, subscribeDaemonEvent } from "./wire-access.js";
