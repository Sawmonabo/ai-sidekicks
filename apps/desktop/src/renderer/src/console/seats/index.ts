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

// The two contexts come off their own modules rather than off the boards that hand them
// out. They were hoisted there to break a cycle — a board reaches the reserved frame it
// mounts while a loader-backed body is in flight, and that frame names the context — and
// re-exporting them from the boards here would put this door's readers back on a
// specifier the declaration no longer lives at.
export type { ConsolePaneContext } from "./pane-context.js";
export type { ConsoleSurfaceContext } from "./surface-context.js";

export {
  /** @consumedBy T-023p-1C-2 */
  DETACHABLE_PANE_KINDS,
  /** @consumedBy T-023p-1C-2 */
  PANE_KINDS,
  isDetachablePaneKind,
  /** @consumedBy T-023p-1C-2 */
  isPaneKind,
  type PaneKind,
} from "./pane-kinds.js";

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
  /** @consumedBy T-023p-1C-2 */
  composerSeatRenderer,
  registerComposerSeat,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  unregisterComposerSeat,
  type ComposerSeatProps,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ComposerSeatRenderer,
} from "./composer-seat.js";

export {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  sidebarSectionRegistry,
  /** @consumedBy T-023p-1C-3 */
  sidebarSectionRenderer,
  type SidebarSectionAttention,
  type SidebarSectionContext,
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
  InlineCardSeatRegistry,
  /** @consumedBy T-023p-1C-2 */
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
  /** @consumedBy T-023p-1C-2 */
  type InlineCardSeatProps,
} from "./inline-card-seats.js";

// The pane chrome and the seam its two host controls travel on, and four markers now
// in two different states — which is the marker rule working rather than two spellings
// of one thing.
//
// The chrome's three lines carry NOTHING. A shipped pane body imports all three, which
// is the event those claims named, and a surviving `@consumedBy` would fail the
// dead-code gate under `--treat-tag-hints-as-errors` rather than exempt anything.
//
// `PaneControlsContext` carries the `// Consumed by` LINE rather than a tag, which is
// the other half of the same rule. The agent console is one of the kinds the window
// model can open, so whether its deck mount reaches the chrome decides whether the
// detach control can be drawn at all — and the only honest way to assert that is to
// provide the host's controls through the seam a deck provides them through, which its
// mounts' suite now does. A test reader makes knip's exemption unnecessary and is not
// the production reader the barrel census wants, so the claim sits on the marker the
// package standard pairs with exactly that case. `PaneControls` keeps its TAG: the
// value a deck constructs is still nobody's until the deck lands, and that reader hands
// the provider an inline object rather than naming the type.
//
// `OwnerSlotContract` carries NEITHER any more. A shipped family names the type on every
// slot it declares, which is the event its tag reserved the export for, and a marker
// that outlives its consumer fails the dead-code gate under `--treat-tag-hints-as-errors`
// rather than exempt anything — so the tag leaves in the diff that imports the symbol.
export { ConsolePaneChrome, paneBodyForKind, type PaneContextOf } from "./ConsolePaneChrome.js";

export {
  // Consumed by T-023p-1C-2
  PaneControlsContext,
  /** @consumedBy T-023p-1C-2 */
  type PaneControls,
} from "./pane-controls.js";

export type { OwnerSlotContract, OwnerSlotProps } from "./owner-slot.js";

// The session vocabulary, straight from the module that DECLARES it rather than
// through `store/index.js`, which would be a barrel chain. Without these four lines
// the door written for the view families is unreachable through the one import path
// they are allowed to use: a pane reaching `../../seats/session-subject.js` is a deep
// cross-family import the package standard forbids, so the only other answer would be
// not to bind at all. Both gates were green on that for reasons neither intends — the
// module's own test keeps it reachable, and it imports two families so it is no
// orphan — which is why the census below is the thing that says who owes the rebind.
export { isCurrentSessionSubject, useSessionScopedState } from "./session-subject.js";
export type {
  /** @consumedBy T-023p-1C-3 */
  SessionScopedKey,
  SessionSubject,
} from "./session-subject.js";

// The node's session directory — the read, and the offer a picker draws from it.
//
// In this family because its one input is the growth port and `seats/` is the lowest
// family above `bridge/`. It was authored in `frame/` when the frame was its only
// reader; it has readers on both sides of the frame now, and neither `frame/` nor its
// door is reachable from below.
export { offeredSessionIds, useSessionDirectory } from "./session-directory.js";
export type { SessionDirectoryState } from "./session-directory.js";

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

// The mounts for the four shipped Tier-1 families the console absorbed, three of them
// carrying the bridge-source guard that decides whether they may be mounted at all.
//
// In this family because a mount reads a bridge source, two primitives and the console's
// own bridge, and nothing above `bridge/`, and on this door because the surfaces that
// mount them are view families — `frame/legacy-surfaces.ts` holds the slot table and
// reaches them here like every other consumer.
export {
  renderAbsorbedInviteAcceptance,
  renderAbsorbedNodeRoster,
  renderAbsorbedParticipantRoster,
  renderAbsorbedSessionProbe,
} from "./absorbed-surfaces.js";
