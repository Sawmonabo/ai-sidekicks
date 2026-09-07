// The seats family's door — and the one place view families reach each other.
//
// The family holds the session workspace's shared vocabulary: the seats through
// which the view families hand each other panes, a composer, sidebar sections,
// timeline rows, and inline cards, and the surface registry through which a family
// hands the frame a whole route's body. It sits directly above `bridge/` and below
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
// `bridge/`. The surface registry was read the same way and answered the same slot,
// which is why it moved here from `frame/` and took the console's last named layering
// exemption with it. Lower is also the more permissive choice for the two families that sit
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
// ONE THING HERE RENDERS, AND IT IS THE FRAME RATHER THAN A BODY. `ConsolePaneChrome`
// is the chrome every pane wears — kind glyph, breadcrumb, control strip, focus
// treatments — and it is here for the same reason every other seat is: the deck that
// provides its two host controls is a VIEW family, six sibling families each draw a
// pane inside it, and a sibling may not import a sibling. Six frames drawn
// independently is six spacings and six answers to where the focus ring goes, which is
// the drift a seat exists to remove. The rule it does not break is the one that
// matters: a seat may not hold a BODY, and this holds none — every pane's content
// arrives as `children` from the family that owns it. Its stylesheet is imported below,
// where every console family imports its own.
//
// NOTHING ELSE HERE RENDERS. No store, no scenario, no second console component.
//
// `absorbed-surfaces.ts` is the one module here that BUILDS elements, and every
// component it builds is owned by a renderer subtree outside the console: the four
// shipped Tier-1 families the console absorbed by import. That is not a sibling's
// body — it is a component with no owner left to mount it, handed to whichever
// console surface absorbed it. Four view families reach for one of those mounts, so
// the mounts sit here for exactly the reason every other seat does.
//
//
// THE `@consumedBy` TAGS BELOW are the dead-code gate's one exemption, on the terms
// `apps/desktop/AGENTS.md` sets: every seat is reached by a task that has not landed,
// so each specifier names the task or tasks that will import it. The tag rides the
// SPECIFIER because that is the export knip reports; the declaration in the seat's own
// module carries the same claim as a `// Consumed by` line. Both go in the PR that
// imports the symbol — a tag that outlives its consumer fails the run.

import "./pane-chrome.css";
import "./sidebar-section-list.css";

// How a family reaches the screen: the registry it claims a slot in, the call that
// claims one, and everything a mounted surface is handed. Here rather than in
// `frame/` because this is the same kind of contract every other seat is — a family
// hands the frame a body through it — and because a view family cannot import the
// frame's door at all without closing a cycle back through `families.ts`. No
// `@consumedBy` claims: the frame, the composition root and the legacy surfaces all
// read these today.
//
// Three names are deliberately absent, each because no PRODUCTION module reaches it
// through this door and the barrel census fails a line like that. `ConsoleSurfaceSlot`
// is reached through the descriptor a family fills in. `CONSOLE_SURFACE_SLOTS`'s only
// reader is `families.test.ts`. `registerConsoleSurface` — the module-scope door a
// plan-owned subtree mounting into the console would call — has no caller outside this
// family yet; the family that lands the first one adds the line in its own diff.
export {
  ConsoleSurfaceRegistry,
  consoleSurfaceRegistry,
  surfaceSlotFor,
  type ConsoleSurfaceDescriptor,
} from "./surface-registry.js";

// The frame-lifetime binding seat, beside the four that mount bodies. It is on this
// door for the same reason every other board is — a family claims a place on it and
// the composition hands the board out — and `mountFrameBindings` is here because the
// frame is the one caller that wraps a subtree in what the board holds.
//
// FOUR SPECIFIERS AND NOT EIGHT. The slot enumeration, its derived union, and the
// descriptor are the board's INTERNAL vocabulary: a family names its slot as a string
// literal inside the descriptor it registers and never imports the union to do it, so
// publishing them here would put four names on this door that only the declaring
// module and its tests reach. `families.test.ts` imports them from that module
// directly, on the rule `DuplicateRegistrationError` already follows one layer down.
//
// No `@consumedBy` claims: the composition root, the frame, and the family that fills
// the one declared slot all read these today.
export {
  FrameBindingRegistry,
  frameBindingRegistry,
  mountFrameBindings,
  type FrameBindingContext,
  type FrameBindingProps,
} from "./frame-bindings.js";

// The two contexts come off their own modules rather than off the boards that hand them
// out. They were hoisted there to break a cycle — a board reaches the reserved frame it
// mounts while a loader-backed body is in flight, and that frame names the context — and
// re-exporting them from the boards here would put this door's readers back on a
// specifier the declaration no longer lives at.
export type { ConsolePaneContext } from "./pane-context.js";
export type { ConsoleSurfaceContext } from "./surface-context.js";

// `PANE_KINDS` and `EPHEMERAL_PANE_KINDS` are deliberately absent: every reader of
// either SET is inside this family or is a suite that drives the kinds directly, and
// both take `seats/pane-kinds.js` by its own specifier. A door line no production
// module reads is one the barrel census fails, so the sets leave rather than being
// tagged. Their two predicates stay, because the deck asks both of them.
export {
  /** @consumedBy T-023p-1C-2 */
  DETACHABLE_PANE_KINDS,
  isDetachablePaneKind,
  isEphemeralPaneKind,
  isPaneKind,
  type PaneKind,
} from "./pane-kinds.js";

export {
  /** @consumedBy T-023p-1C-3 */
  clearComposerAttachMenu,
  /** @consumedBy T-023p-1C-3 */
  composerAttachMenuEntries,
  registerComposerAttachMenuEntry,
  /** @consumedBy T-023p-1C-3 */
  type ComposerAttachMenuContext,
  type ComposerAttachMenuEntry,
  type ComposerAttachOutcome,
} from "./composer-attach-menu.js";

export {
  /** @consumedBy T-023p-1C-2 */
  panesForLayoutSnapshot,
  /** @consumedBy T-023p-1C-2 */
  panesFromLayoutSnapshot,
  /** @consumedBy T-023p-1C-2 */
  type LayoutPaneDrop,
  /** @consumedBy T-023p-1C-2 */
  type LayoutPaneDropCode,
  /** @consumedBy T-023p-1C-2 */
  type LayoutRestoreReading,
} from "./layout-snapshot.js";

export {
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  paneEntityScopeFor,
  type ConsolePaneAddress,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type PaneEntityScopeDeclaration,
} from "./pane-address.js";

export { parseConsolePaneAddress } from "./pane-address-parse.js";

export {
  ConsolePaneRegistry,
  consolePaneRegistry,
  /** @consumedBy T-023p-1C-2, T-023p-1C-8 */
  registeredPaneKinds,
  type ConsolePaneDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ConsolePaneLink,
  type ConsolePaneOpener,
  type ConsolePaneRegistration,
} from "./pane-registry.js";

// The idle warm and its scheduler. Published because the composition that owns a
// window's first frame is the one that starts the walk, and that composition is
// `frame/`, a family above this one — the seam a view family never touches.
export { LazyBodyIdleWarm, idleWarmScheduler, type IdleWarmScheduler } from "./lazy-body-warm.js";

// THE LOADER MECHANISM, PUBLISHED FOR THE ONE BOARD THAT IS NOT IN THIS DIRECTORY.
//
// It was absent from this door while the deck's pane registry and the frame's surface
// registry were the only boards that normalised a loader into a descriptor, and both sit
// here. The settings family's page registry is a third: its rail mounts one page per
// section, a page's body is a chunk like any other, and a settings page reachable from a
// family door that another family imports EAGERLY is on every launch's initial graph
// whether or not settings is ever opened — which is the defect
// `settings/settings-page-registry.ts` records measuring. Building a second normaliser
// beside `LoadedLazyBody` would have been two settle semantics to keep in step, so the
// board that lives outside this directory reads the one that already exists.
//
// `PENDING_PANE_BODY_ATTRIBUTE` joins it, and the reason the marker had no door line
// expires with the same change: it had exactly one reader outside this directory and that
// reader was a test — the screenshot tier's capture helper, which refuses to photograph a
// half-loaded body — so a door line would have been a specifier no shipped module reads,
// which `architecture/barrel-census.test.ts` fails rather than tolerates. A settings page
// waiting on its chunk is the same hazard the marker exists for, so the attribute now has
// a production reader and a door line is what it is owed. `pendingPaneKindsIn` and
// `pendingPaneBodiesIn` still have none and still take the leaf directly, for the reason
// above: their only consumer outside this directory is that helper.
//
// `LazyBodyBoard` and `LazyBodyModule` stay absent — named only by the boards and the
// walk in this directory — and a family declaring a loader beside its registration writes
// `body: () => import("./x-body.js")` inline, which names no type at all.
export { PENDING_PANE_BODY_ATTRIBUTE } from "./pending-pane-body.js";
export { LoadedLazyBody, type LazyBodyLoader } from "./lazy-body.js";

export {
  actorFollowHandler,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
  type ActorFollowHandler,
  type ActorFollowOutcome,
  type ActorFollowRequest,
} from "./actor-follow-seat.js";

// The floor seat — the deck's half of "Step in", filled by the family that owns the
// deck and called by the family that owns the run controls. The release call is on the
// door and the composer seat's is not, because this handler closes over one live deck
// and one live transport: the workspace withdraws it on unmount, where the composer's
// body is registered once for the life of the window.
export {
  registerTakeTheFloorHandler,
  takeTheFloor,
  unregisterTakeTheFloorHandler,
  type FloorWorktreeDisposition,
  type TakeTheFloorHandler,
  type TakeTheFloorOutcome,
} from "./take-the-floor-seat.js";

export {
  composerSeatRenderer,
  registerComposerSeat,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  unregisterComposerSeat,
  type ComposerSeatProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ComposerSeatRenderer,
} from "./composer-seat.js";
// The other direction: a surface that told a person to type something asking the
// mounted composer for the caret. Through the door because the asker and the answerer
// are two view families that name each other nowhere.
export { requestComposerFocus, subscribeToComposerFocus } from "./composer-focus.js";

export {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  sidebarSectionRegistry,
  /** @consumedBy T-023p-1C-3 */
  sidebarSectionRenderer,
  type SidebarSectionContext,
  type SidebarSectionDescriptor,
  type SidebarSectionId,
} from "./sidebar-sections.js";

// The rollup tree and the bulk-selection seam, published beside the sections they
// belong to. Two of the three type names below are read by the sidebar's own fold and
// runner; the two enumerations are what a view family derives its groups and acts from
// rather than restating them.
export {
  SIDEBAR_ROLLUP_GROUPS,
  type SidebarBulkAct,
  type SidebarBulkItem,
  type SidebarBulkOutcome,
  type SidebarBulkSelection,
  type SidebarRollupGroup,
  type SidebarRollupNode,
  type SidebarRowDragBinder,
  type SidebarRowDragTarget,
} from "./sidebar-sections.js";

export {
  /** @consumedBy T-023p-1C-2 */
  TIMELINE_ROW_DENSITIES,
  registerTimelineRowRenderer,
  timelineRowRenderer,
  type TimelineRowDensity,
  type TimelineRowRenderer,
  type TimelineRowSlotProps,
} from "./timeline-row-slot.js";

// The footer seat publishes only what a PRODUCTION reader takes: the shell's
// registration, the ledger's mount, and the two types both name. Its slot contract,
// its row-type tuple, and its release call are read by its own suite alone, which
// reaches the declaring module directly — a door line without a production reader is
// what `barrel-census.test.ts` fails.
export {
  registerTimelineRowFooterRenderer,
  rowTakesFooter,
  timelineRowFooterRenderer,
  type TimelineRowFooterRenderer,
  type TimelineRowFooterSlotProps,
} from "./timeline-row-footer-seat.js";

export {
  /** @consumedBy T-023p-1C-2 */
  INLINE_CARD_KINDS,
  InlineCardSeatRegistry,
  inlineCardBody,
  inlineCardSeatRegistry,
  type ArtifactInlineCardProps,
  type AttachmentInlineCardProps,
  type DiffInlineCardProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type InlineCardAttachmentRef,
  /** @consumedBy T-023p-1C-5 */
  type InlineCardBodyDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type InlineCardKind,
  /** @consumedBy T-023p-1C-2, T-023p-1C-5 */
  type InlineCardPropsByKind,
  type InlineCardSeatProps,
} from "./inline-card-seats.js";

// The pane chrome and the seam its two host controls travel on. No marker on any of
// these lines, and every half of the reason has now happened: shipped pane bodies
// import the chrome and narrow through `paneBodyForKind`; the deck — the one host that
// provides the two controls — ships and mounts every pane inside `PaneControlsContext`,
// so the agent console's detach control is drawn through the seam a deck provides it
// through rather than asserted by a test; and two shipped families name the owner
// slot's contract on the slots they declare — the ledger's message card and timeline
// pane, and the workflows family's own slot table. A surviving tag would fail the run
// under `--treat-tag-hints-as-errors`; the pane-body tasks still to land are consumers
// of exports that already have one.
export { ConsolePaneChrome, paneBodyForKind, type PaneContextOf } from "./ConsolePaneChrome.js";

export { PaneControlsContext, type PaneControls } from "./pane-controls.js";

export type { OwnerSlotContract, OwnerSlotProps } from "./owner-slot.js";

// The session vocabulary, straight from the module that DECLARES it rather than
// through `store/index.js`, which would be a barrel chain. Without these four lines
// the door written for the view families is unreachable through the one import path
// they are allowed to use: a pane reaching `../../seats/session-subject.js` is a deep
// cross-family import the package standard forbids, so the only other answer would be
// not to bind at all. Both gates were green on that for reasons neither intends — the
// module's own test keeps it reachable, and it imports two families so it is no
// orphan — which is why the census below is the thing that says who owes the rebind.
// The hook's claim is retired: the ledger's pane holds its chapter disclosure and
// both of its row-retention tables through this line.
export { isCurrentSessionSubject, useSessionScopedState } from "./session-subject.js";
export type {
  /** @consumedBy T-023p-1C-3 */
  SessionScopedKey,
  SessionSubject,
} from "./session-subject.js";

// The node's session directory — the read, the offer a picker draws from it, and the
// one way a settled act says the node's list has moved.
//
// In this family because its one input is the growth port and `seats/` is the lowest
// family above `bridge/`. It was authored in `frame/` when the frame was its only
// reader; it has readers on both sides of the frame now, and neither `frame/` nor its
// door is reachable from below.
//
// The invalidation door travels with the read for the same reason the read is here: it
// is addressed at the PORT, so the family that settles an act and the three families
// that render the answer reach one generation rather than passing a refresh callback
// down through whichever surfaces happen to sit between them.
export {
  offeredSessionIds,
  requestSessionDirectoryRead,
  useSessionDirectory,
} from "./session-directory.js";
export type { SessionDirectoryState } from "./session-directory.js";

// Whether a first send pins the session it was sent into: the rule, and the record
// the two families that own its halves meet on.
//
// In this family because the halves are in two families that may not import each
// other. Only the sessions destination can say where a session came from — it
// authored the one origin this console reports in full — and only the composer knows
// a send is the first one, because the send path is the composer's; the composer
// lives outside the console entirely and reaches it through family doors alone. The
// rule itself imports nothing at all, so `seats/` is simply the lowest family both
// readers can take it from.
//
// `AutoPinRefusalReason` and `SessionAutoPinAuthority` are deliberately absent. The
// first is read only by the port beside the rule, and the second is met structurally
// by the object the sessions destination composes at a settled start — so a door line
// for either would be a specifier no cross-family import uses.
export { autoPinDecision } from "./auto-pin.js";
export type { AutoPinDecision, SessionOriginEvidence } from "./auto-pin.js";
export { recordConsoleStartedSession, settleFirstSendAutoPin } from "./session-auto-pin.js";

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
  servedGrowthValueOrRaise,
  servedValueOrRaise,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "./push-driven-read.js";

// The console's single copy of the daemon-EVENT cast. The brand
// `SidekicksBridge.daemon.subscribe` takes is `never`-shaped until Plan-007 narrows
// it, and every caller casts; one module casts, and the day the brand narrows one
// file changes. Its call-side twin is gone — `bridge/daemon/daemon-reply.ts` names the
// methods and parses both directions, so no seat casts a call any more.
export { subscribeDaemonEvent } from "./wire-access.js";

// The mounts for three of the four shipped Tier-1 families the console absorbed, two of
// them carrying the bridge-source guard that decides whether they may be mounted at all.
// The fourth, the participant roster, is superseded rather than unhomed — the module
// beside this door says by what, and why keeping a mount for it would be keeping one no
// surface can call.
//
// In this family because a mount reads a bridge source, two primitives and the console's
// own bridge, and nothing above `bridge/`, and on this door because the surfaces that
// mount them are view families, which reach them here like every other consumer.
export {
  absorbedSurfaceAsks,
  renderAbsorbedAttachFlow,
  renderAbsorbedCapabilityDeclaration,
  renderAbsorbedInviteAcceptance,
  renderAbsorbedMixedVersionStatus,
  renderAbsorbedNodeRoster,
  renderAbsorbedSessionProbe,
} from "./absorbed-surfaces.js";

// What the absorbed roster's own read answered, for a surface that renders beside it.
//
// The mount above is the only caller that needs the read SEAM, and it takes it through
// `runtime-node/index.ts`, that directory's own door; what leaves this family is the
// OBSERVATION — a settings page renders a node's declared capabilities and its version
// from the response that view already read, rather than putting a second
// `runtimenode.roster` on the wire that could disagree with what is on screen beside it.
//
// FROM THE DECLARING MODULE AND NOT FROM THAT INNER DOOR: a family door re-exporting
// through a sub-module door is the barrel chain `console-no-barrel-chain` fails, and
// the name would be published twice with nothing saying which line a reader owes.
export {
  useNodeRosterObservation,
  type NodeRosterObservation,
} from "./runtime-node/node-roster-seam.js";

// When that roster is asked to read again. Beside the observation because the settings
// page takes both — it renders from the recorded read and owes that read the signals
// the absorbed view's own presence channel does not carry.
export { useNodeRosterReReadTriggers } from "./runtime-node/node-roster-triggers.js";

// The shared body every sidebar section draws with: the count, the group headings, and
// the rows that open panes, plus the fold that splits a section's rows into groups.
//
// On this door and not in any family's subtree because three DIFFERENT families own the
// eight section bodies — the composer family's `runs` and `approvals`, the collaboration
// family's `channels`, `agents` and `members`, the repos family's `repos` and
// `artifacts` — and one view family may not import another. This is the layer that
// already owns the sidebar-section contract, so the markup that contract implies and
// the fold every body performs leave through the same door the contract does.
//
// `SectionListRow`, `SidebarSectionListProps` and `RowGroupingRules` are deliberately
// absent: a section body composes the groups and names the component, and no reader
// outside this family spells either of those types, so a line for one would be a door
// specifier no production module reads.
export { SidebarSectionList } from "./SidebarSectionList.js";
export type { SectionListGroup } from "./SidebarSectionList.js";
export { groupSectionRows, groupedRowCount, normaliseFilterQuery } from "./section-grouping.js";
