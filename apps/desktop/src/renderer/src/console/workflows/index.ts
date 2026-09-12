// The workflows family's door.
//
// The family is the workflows destination's own surface — the definitions browser — plus
// the two pane kinds the console design reserves for it, `workflow-run` and
// `workflow-builder`. Both pane BODIES live under `./pane/`, inside the family that owns
// them: `console/panes/` is the deck's composition site and holds composition files only,
// so a body there would be one directory's while the vocabulary it is built from was
// another's. Each body has its own sub-module door, reached from here by a deep
// intra-family specifier.
//
// WHAT LEAVES THE FAMILY IS TWO REGISTRATIONS AND ONE SEAT LOADER. Not the surface,
// not the panes, not the chrome: the console composes this family by calling
// `registerWorkflowPanes` at its pane seat and `registerWorkflowSurfaces` at its
// surface seat, and nothing above needs a handle on a body. An export beyond those
// would be an invitation for another family to mount a workflows surface itself,
// which is the coupling the deck's and the frame's single mount doors exist to
// prevent.
//
// THE ONE EXCEPTION IS A SEAT SOMEBODY ELSE OWNS, WHICH IS THE OPPOSITE SHAPE. The
// composer's `+` menu holds a reserved place for "Start a workflow" — the seat is the
// composer's, the position and the session are the composer's, and what goes inside is
// this family's enumeration and this family's start. A board cannot carry it: the deck
// keys registrations by pane kind and the frame by surface slot, and a menu entry is
// neither. So what leaves through this door is that body's LOADER, and the composer
// normalises it in one line — the same direction as a registration, this family handing
// something to a seat above it, written the only way a menu entry can be written.
//
// A LOADER AND NOT THE COMPONENT, because this door is on the eager graph. It was the
// component for one round, and what that cost is stated where it is paid: `families.ts`
// imports this module to register the surfaces below, so a re-export put the picker, the
// definition directory it reads through, the start act it dispatches, and this family's
// menu sheet into the entry chunk of every session — including every session whose
// composer never opened that menu.
//
// TWO SEATS BECAUSE THERE ARE TWO BOARDS. The deck's board is keyed by pane kind
// and the frame's by surface slot; this family occupies one seat on each — the two
// pane kinds it claims, and the rail destination the spec's surface set gives it.
// Until the surface seat was filled, pressing the rail's middle destination reached
// the frame's reserved-slot absence, which was a true sentence about a browser this
// family had in fact already built.
//
// THE FAMILY'S SHARED SHEET IS NOT IMPORTED HERE ANY MORE. Every one of this family's
// bodies arrives behind a loader now, and the one element this module builds — the pinned
// region below — draws no class `workflows.css` declares, so nothing statically reachable
// from this module can render against it. A door sheet no reader on the door's own graph
// can use is charged to every session and painted for none of them. The three chunk roots
// that paint this family's chrome import it instead, which is the rule
// `apps/desktop/AGENTS.md` states from the other side: the stylesheets a lazily-loaded
// directory owns enter through that chunk's root. The picker's root names its own menu
// sheet on that same rule and does NOT name `workflows.css`, because what it paints
// inside is the composer's `+` panel rather than this family's chrome.
//
// THREE SHEETS STAY, AND ONE REASON DOES NOT COVER ALL THREE.
//
// `runs/run-list.css` stayed because its position in the cascade was not this family's to
// decide: it declares `.meridian-run-row__failure` and `runs/pane/runs.css` declared the
// same name for a different shape, so which of the two the browser saw LAST decided how a
// failed run's line read in both families. THAT COLLISION IS SETTLED — every class that
// pane draws is `meridian-runs__*` now, prefixed for the block its own sheet declares —
// and this sheet's placement is no longer holding it. It stays on the initial document
// only until a change that measures the deferral takes it off, which is a bundle question
// rather than a cascade one and belongs to whoever moves it.
//
// `parks/park-badge.css` and `channel-progress/channel-progress.css` stay because the
// pinned region below is drawn on the first paint. That registration is a `render` and
// not a loader — the seat itself says why — so `ChannelWorkflowProgressCard`,
// `PinnedRunCard` and `ParkBadge` all sit on this door's own static graph, and a sheet
// declaring the classes they draw would arrive with whichever workflows chunk happened to
// load first, leaving the card undressed above the flagship pane until then. Both sheets
// reached the document through `workflows.css` until this module took the region; they
// enter here now, one edge each, and no chunk root re-imports what the door carries.
//
// WHY THIS BARREL BUILDS AN ELEMENT RATHER THAN BEING A `.tsx`. It owns a TABLE — kind,
// owner, and the specifier each body arrives behind — plus the one `createElement` the
// pinned region's seat takes, which is the same reason `seats/surface/absorbed-surfaces.ts`
// builds its mounts with `createElement`. Written as a component file it would be a
// `.tsx` holding no component at all.

import "./runs/run-list.css";
import "./parks/park-badge.css";
import "./channel-progress/channel-progress.css";

import { createElement } from "react";

// BOTH SEATS ARE ONE ORDINARY DOOR NOW. Both boards were authored in `frame/`, which
// a view family cannot import at all — that door re-exports `ConsoleRoot`, which
// composes `families.ts`, which composes this family — so the registrations were taken
// by a deep specifier the layering config subtracted at the `to` end by name. The
// substrate hoisted both boards down to `seats/`, which sits below every view family,
// so this is one edge through one door and the config carries no exemption for it.
import {
  type ConsolePaneRegistration,
  type ConsolePaneRegistry,
  type ConsoleSurfaceRegistration,
  type ConsoleSurfaceRegistry,
  type LazyBodyLoader,
  type PinnedPaneRegionRegistry,
} from "../seats/index.js";
import { ChannelWorkflowProgressCard } from "./channel-progress/ChannelWorkflowProgressCard.js";
// TYPE-ONLY, WHICH IS THE WHOLE POINT OF THE FORM. The loader below is typed against the
// picker's own props, and a value import of that module would be a static edge into the
// directory the loader defers — the shape this boundary exists to prevent. A type
// import is erased before the bundler sees the graph, so it carries none.
import type { WorkflowStartMenuProps } from "./start/WorkflowStartMenu.js";

/**
 * The family's owner string, as the pane registry's duplicate policy reads it.
 *
 * One binding rather than two literals: the registry's policy is owner-scoped, so a
 * hot reload re-registering under the same owner replaces and a DIFFERENT owner
 * claiming a taken kind raises. Two literals that drifted by a character would make
 * the second registration a conflict with the first — a failure that reads as a seat
 * collision between families when it is one typo inside one.
 */
const WORKFLOWS_OWNER = "workflows";

/**
 * Both pane kinds this family claims.
 *
 * NO TEAR-OFF ANSWER TRAVELS WITH THEM, deliberately: whether a kind may be torn off into
 * an auxiliary window is `seats/pane/pane-kinds.ts`'s `isDetachablePaneKind`, derived
 * from the window model's own closed set. The console ships exactly two auxiliary
 * windows, `timeline` and `agent-console`, and neither of these is one — but a boolean
 * stated here would be asked of each descriptor independently, so a kind could advertise
 * a detach path the window model cannot serve and neither this registration nor the type
 * system would notice.
 *
 * THE NARROWING AND ITS REFUSAL ARE THE SEAT'S, NOT THIS FAMILY'S. The registry hands
 * every body the whole context union and only one arm is each pane's; the mismatched
 * arm is unreachable through the deck and is rendered rather than thrown anyway,
 * because `core/refusal.ts`' rule is that a boundary refuses by name and leaves the
 * surface standing. Six families answering that once each is six sentences for one
 * case, which is what `paneBodyForKind` exists to prevent — applied by each body module
 * this table names rather than here, since a loader-form registration carries a
 * specifier and not a render.
 */
const WORKFLOW_PANES: readonly ConsolePaneRegistration[] = [
  {
    kind: "workflow-run",
    owner: WORKFLOWS_OWNER,
    // A LOADER, like the builder below it: a run pane opens from the destination's run
    // list or from a run address, so nothing paints it before a person asks.
    //
    // IT WAS A `render` FOR ONE ROUND, and the reason it no longer is belongs here rather
    // than in the body: `pane/run/run-controls.css` and `runs/pane/runs.css` both declared
    // `.meridian-run-controls` with different layout declarations and disjoint children,
    // so which sheet the browser saw LAST decided how this pane laid its operator controls
    // out — and deferring this body moved this family's sheet to the end of that cascade.
    // Keeping the body eager hid the coupling instead of removing it. The class has one
    // owner now: this family's block is `meridian-workflow-run-controls` and the runs
    // family keeps the name it was already declaring, so no bundle boundary decides how
    // either surface looks. The module-shape rule in `apps/desktop/AGENTS.md` keeps a
    // second collision from landing unnoticed, and review is what reads it.
    body: () => import("./pane/workflow-run-pane-body.js"),
  },
  {
    kind: "workflow-builder",
    owner: WORKFLOWS_OWNER,
    // The builder carries its own sheet, which no other family declares against, so
    // its body travels as its own chunk: the rail's destination opens it and nothing
    // paints it before a person asks.
    body: () => import("./pane/workflow-builder-pane-body.js"),
  },
];

/**
 * How the composer's `+` menu reaches this family's workflow picker.
 *
 * A LOADER AND NOT THE COMPONENT, which is the same boundary the four registrations
 * around it take and the reason this line is a function rather than a re-export. The
 * menu is closed until somebody presses its disclosure, so the picker is not painted
 * before a person acts — and a door line naming the component would put the body, the
 * definition directory it reads through, the start act it dispatches, and this family's
 * menu sheet into the entry chunk of every session, because `families.ts` imports this
 * door eagerly to register the surfaces above.
 *
 * THE SEAT BUILDS THE `LoadedLazyBody`, not this door, and the split is the one every
 * loader-backed body already follows: what a body reserves while it loads is a question
 * about the frame it loads inside, and that frame is the composer's `+` panel. A board
 * cannot carry this registration at all — the deck keys by pane kind and the frame by
 * surface slot, and a menu entry is neither — so the loader leaves through this door and
 * the composer normalises it in one line, which is the same direction a registration
 * travels written the only way a menu entry can be written.
 */
export const workflowStartMenuBody: LazyBodyLoader<WorkflowStartMenuProps> = () =>
  import("./start/workflow-start-menu-body.js");

/**
 * Claim this family's pane kinds against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsolePanes`' reason: a test composes the same bodies into a registry it
 * owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowPanes(registry: ConsolePaneRegistry): void {
  for (const descriptor of WORKFLOW_PANES) {
    registry.register(descriptor);
  }
}

/**
 * Both surface slots this family claims.
 *
 * A TABLE NOW, because there are two of them. It was written out inline while there was
 * exactly one, on the reasoning that a one-row table invites a second row nobody decided
 * to add — and the second row is decided: the rail's destination, and the workspace
 * address that names one phase of one run.
 *
 * TWO SLOTS AND NOT ONE SURFACE THAT BRANCHES, because the two are reached differently
 * and mount different things. `#/workflows` is a rail destination with no session, so it
 * resolves a scope before it can read anything; a phase address carries its session and
 * its run already and has nothing to resolve. Folding them together would put a
 * destination's scope picker above a link somebody followed to one run.
 *
 * IT ALSO CLAIMS ONE PINNED REGION, and both claims travel on one seat because both
 * are this family's. A channel-scoped `timeline` pane pins this family's run progress
 * above its body: the pane belongs to another family, the fold belongs to this one,
 * and `apps/desktop/AGENTS.md` refuses the sibling import that would otherwise join
 * them — so the join is the seat, and the family that owns the DATA is the family that
 * registers. The board is a parameter for the same reason the registry is.
 */
const WORKFLOW_SURFACES: readonly ConsoleSurfaceRegistration[] = [
  {
    slot: "workflows",
    owner: WORKFLOWS_OWNER,
    // A LOADER, and the seat's reasoning about WHICH component to mount moved with it
    // to `workflows-surface-body.ts`. `#/workflows` is a rail destination — nothing
    // paints it until a person asks — so registering it with a `render` put the host,
    // the scope picker, the definitions browser and the run list on every session's
    // initial graph and left `preload("workflows")` with nothing to fetch.
    body: () => import("./workflows-surface-body.js"),
  },
  {
    slot: "workflow-phase",
    owner: WORKFLOWS_OWNER,
    // A LOADER for the same test: this surface is reached by following a link — a park
    // banner, a run row, a notification raised somewhere else — and is painted before
    // nobody. Its chunk carries the surface and not the pane, which is a loader-backed
    // registration of its own on the board above.
    body: () => import("./phase-link-surface-body.js"),
  },
];

/**
 * Claim this family's surface slots against a registry, and its one pinned region
 * against the board.
 *
 * Takes the registry rather than the module-scope singleton, for
 * `registerWorkflowPanes`' reason: a test composes the same surfaces into a registry
 * it owns, and an auxiliary window composes a different subset without a second code
 * path.
 */
export function registerWorkflowSurfaces(
  registry: ConsoleSurfaceRegistry,
  pinnedRegions: PinnedPaneRegionRegistry,
): void {
  for (const descriptor of WORKFLOW_SURFACES) {
    registry.register(descriptor);
  }
  // `timeline` and no other kind. The card is about a CHANNEL's workflow, and the
  // channel-scoped timeline is the pane a channel's conversation happens in; a region
  // registered for `runs` or `workflow-run` would be this family pinning its own fold
  // above its own body, which is a body's job.
  //
  // The narrowing to a channel is the CARD's rather than this registration's: the seat
  // is keyed by pane kind, a `timeline` pane is session- or channel-scoped, and a
  // registration that could only say "this kind" would have had to be re-asked on every
  // render anyway. The card renders nothing on a session-scoped pane, which is the same
  // nothing it renders for a channel that started no workflow.
  //
  // A `render` AND NOT A LOADER, which is this family's only one and is the arithmetic
  // rather than a preference. `timeline` is the flagship first paint, so a loader here
  // would start a fetch on every channel timeline that mounts — and the card's answer
  // for a session-scoped pane, and for a channel that started no workflow, is no element
  // at all. That is a chunk fetched on the launch path to draw nothing for most of the
  // sessions that pay for it, which is the opposite trade from the three bodies above.
  // What it costs is stated where it is paid: the two sheets this card and its badge
  // draw against enter at the door, and the header says so.
  pinnedRegions.register("timeline", {
    owner: WORKFLOWS_OWNER,
    render: (context) =>
      createElement(ChannelWorkflowProgressCard, {
        sessionId: context.sessionId,
        channelId: context.channelId,
        // Forwarded, never sourced: the opener is the deck's, the chrome read it off
        // the host's controls, and a registration that reached for one of its own
        // would open this card's route in a deck nobody was looking at.
        openPane: context.openPane,
      }),
  });
}
