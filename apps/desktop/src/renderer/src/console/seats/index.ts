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
  type ConsoleSurfaceContext,
  type ConsoleSurfaceDescriptor,
} from "./surface-registry.js";

// `PANE_KINDS` is deliberately absent: every reader of the set itself is inside this
// family or is a suite that drives the kinds directly, and both take
// `seats/pane-kinds.js` by its own specifier. A door line no production module reads
// is one the barrel census fails, so the set leaves rather than being tagged.
export {
  /** @consumedBy T-023p-1C-2 */
  DETACHABLE_PANE_KINDS,
  isDetachablePaneKind,
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
  type ConsolePaneContext,
  type ConsolePaneDescriptor,
  /** @consumedBy T-023p-1C-2, T-023p-1C-3 */
  type ConsolePaneLink,
  type ConsolePaneOpener,
} from "./pane-registry.js";

export {
  actorFollowHandler,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
  type ActorFollowHandler,
  type ActorFollowOutcome,
  type ActorFollowRequest,
} from "./actor-follow-seat.js";

export {
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
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  sidebarSectionRegistry,
  /** @consumedBy T-023p-1C-3 */
  sidebarSectionRenderer,
  type SidebarSectionContext,
  type SidebarSectionDescriptor,
  type SidebarSectionId,
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

export {
  /** @consumedBy T-023p-1C-2 */
  INLINE_CARD_KINDS,
  InlineCardSeatRegistry,
  inlineCardBody,
  inlineCardSeatRegistry,
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
  type InlineCardSeatProps,
} from "./inline-card-seats.js";

// The pane chrome and the seam its two host controls travel on. No marker on any of
// these lines, and every half of the reason has now happened: shipped pane bodies
// import the chrome and narrow through `paneBodyForKind`; the deck — the one host that
// provides the two controls — ships and mounts every pane inside `PaneControlsContext`,
// so the agent console's detach control is drawn through the seam a deck provides it
// through rather than asserted by a test; and the ledger's message card and timeline
// pane read the owner slot's contract. A surviving tag would fail the run under
// `--treat-tag-hints-as-errors`; the pane-body tasks still to land are consumers of
// exports that already have one.
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
  renderAbsorbedInviteAcceptance,
  renderAbsorbedNodeRoster,
  renderAbsorbedSessionProbe,
} from "./absorbed-surfaces.js";
