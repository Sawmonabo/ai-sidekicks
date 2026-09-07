// Where the console's view families are composed in, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL
//
// Seven surface families (T-023p-1C-2 … T-023p-1C-8) are built on branches that run
// at the same time. Each has to become reachable from the entry point, and there is
// exactly one way to do that without every branch editing the same registry: give
// each family a SEAT — one line, reserved in advance, that only that family
// replaces. Each branch then produces one one-line diff at a position no other
// branch touches, and none of them conflicts.
//
// SEVEN IS THE ONLY COUNT THIS HEADER STATES, and it is the number of reserved seat
// lines at the foot of the composition — asserted by `families.seat-board.test.ts`
// rather than kept in step by hand. It was not: this header spelled the count twice
// and the spellings disagreed, because 1C-8 was read as an audit task when it lands a
// family of its own. A second spelling of one count is a second thing to edit, and the
// one that goes stale is the one nothing reads.
//
// WHAT A FAMILY DOES
//
// A family exports `register<Family>(registry: ConsoleSurfaceRegistry): void` from
// its own `index.ts`, claims its slots inside that function, and replaces its own
// placeholder line below with the import and the call. That is the whole contract.
//
// WHAT A FAMILY DOES NOT DO
//
// A family never edits `seats/surface-registry.ts`, `bridge/scenario-runtime/scenario-manifest.ts`,
// `bridge/growth-port/growth-slate.ts`, or `vitest.config.ts`. Those are shared spines: a
// concurrent edit to any of them from every one of those branches at once is a
// guaranteed conflict, and worse, a merge that resolves cleanly while silently
// dropping one family's registration.
// A family registers through its own `index.ts` and its own reserved lines — here,
// and in `bridge/scenarios/index.ts` for its fixture scenario.
//
// ORDER IS THE DAG, NOT PREFERENCE
//
// Calls run in family order, low to high, matching the import DAG the families
// themselves obey. A family that needed to run before another to work would be
// telling us it has a dependency it has not declared.
//
// COMPOSITION ONLY
//
// No logic lands here. If this file ever needs a condition, a try, or a value of
// its own, the thing it is deciding belongs in the family that owns the decision.

import { registerCollaborationFamily } from "./collaboration-family.js";
import { registerComposerFamily } from "../shell/index.js";
import { registerLegacySurfaces } from "./frame/legacy-surfaces.js";
import { registerPaneHarnessSurface } from "./frame/PaneHarnessSurface.js";
import { registerRunLifecycleProjectors } from "./frame/run-lifecycle-projector.js";
import { registerConsolePanes } from "./panes/index.js";
import { registerRepos } from "./repos/index.js";
import type { ConsoleEntityProjectorRegistry } from "./store/index.js";
import type {
  ConsolePaneRegistry,
  ConsoleSurfaceRegistry,
  FrameBindingRegistry,
  InlineCardSeatRegistry,
  SidebarSectionRegistry,
} from "./seats/index.js";
import { registerWorkflowSurfaces } from "./workflows/index.js";

/**
 * Register every shipped view family against the six boards a composition owns.
 *
 * ALL SIX ARE PARAMETERS, and each one after the first is this signature's history.
 * The surface registry was passed in from the start so a test could compose into a
 * registry it owns and an auxiliary window could compose a subset; the pane
 * board beside it reached for the module-scope singleton, so a caller composing its
 * own family set still registered panes into the production one. That is inert only
 * while every pane seat is still reserved — the moment the first family registers a
 * body, an independent composition mutates the running console's deck, two
 * compositions leak registrations into each other, and an auxiliary window cannot
 * select a different pane subset however carefully it asks.
 *
 * The projector board is the third for the same reason and a sharper one: the session
 * store's fold used to be a CONSTANT decided in the frame, so no family could project
 * its own event category into the partition it owns. A family that cannot do that
 * reads the wire twice — once through its own read and again through a subscription
 * it should not need — and keeps the result beside the store instead of in it. It is
 * a parameter here so a test and an auxiliary window compose their own fold, exactly
 * as they compose their own surfaces and panes.
 *
 * The sidebar board and the inline-card board are the fourth and fifth, and they are
 * here BEFORE a family fills either — which is the point. `seats/sidebar-sections.ts`
 * is filled by three families and `seats/inline-card-seats.ts` by two, and both ship a
 * module-scope registrar that writes straight into the process-wide board. A family
 * reaching for one of those bypasses this composition entirely: an independent
 * composition would then mutate the running console, two compositions would leak into
 * each other, and an auxiliary window could not select a subset however it asked —
 * the same three failures the pane board's paragraph above names, on two boards where
 * they have not happened yet. Taking them as parameters now is what gives the first
 * family that fills a section or a card something to be handed instead.
 *
 * The frame-binding board is the sixth, and it is the first that is not a place to
 * hand over a BODY. The four above it are all mounted when something is looking at
 * them and unmounted when the route moves on, which is right for a body and wrong for
 * a read the frame renders: the rail's attention count comes from a view family's
 * read, and while that read was mounted by a destination the count vanished whenever
 * a person navigated away — a suppressed badge on a perfectly reachable machine,
 * which is the one thing the design's degraded rule exists to distinguish. A binding
 * is mounted once, around the frame's own subtree, for as long as the window holds a
 * bridge, and `seats/frame-bindings.ts` says the rest.
 *
 * Required rather than defaulted to the singletons, because a default is the same
 * hard-coding one parameter along: a caller that forgets it still writes into
 * production. Naming all six at the one composition site is what makes a composition
 * legible as a whole.
 */
export function registerConsoleFamilies(
  surfaces: ConsoleSurfaceRegistry,
  panes: ConsolePaneRegistry,
  projectors: ConsoleEntityProjectorRegistry,
  sidebarSections: SidebarSectionRegistry,
  inlineCardSeats: InlineCardSeatRegistry,
  frameBindings: FrameBindingRegistry,
): void {
  // The three shipped Tier-1 families come first, because they were mounted
  // before any of the seats below existed. A family filling a seat that one of
  // them currently holds REPLACES it — delete that line, do not add beside it.
  // The registry refuses a second owner on one slot rather than letting import
  // order decide which surface mounts, so a seat added without the deletion is a
  // conflict the composition test names by slot rather than a silent swap.
  registerLegacySurfaces(surfaces);
  // The deck's pane bodies have their own seat board, keyed by pane kind
  // rather than by surface slot. It is composed here so one call reaches the
  // whole console, and it takes the pane registry this function was HANDED —
  // the pane table is not the surface table, and it is not the caller's
  // business twice over which of the two a composition is allowed to own.
  registerConsolePanes(panes);
  // The frame's own projector claim, on the same terms as any family's. It is a
  // registration and not a constant handed downstream, because the fold a store is
  // opened with is what decides which family can own which partition — and it takes
  // the projector board this function was HANDED, so a composition writes its fold
  // where it writes its surfaces and its panes.
  registerRunLifecycleProjectors(projectors);
  // The fixture-only pane harness, which is the one surface that mounts a
  // REGISTERED pane body in a running window. It takes both boards because it
  // resolves its body out of the pane board this composition owns, and it decides
  // for itself — behind `__SIDEKICKS_CONSOLE_FIXTURES__`, inside its own module —
  // whether it registers at all, so no condition lands here. It is composed after
  // `registerConsolePanes` because that is the family order; resolution happens at
  // render, so the order is legibility rather than a dependency.
  registerPaneHarnessSurface(surfaces, panes);
  // The browser-terminal family has landed and claims no surface slot: both of its
  // kinds are pane bodies, registered through `registerBrowserPanes` and
  // `registerTerminalPanes` on the pane board in `panes/index.ts`, so it has nothing
  // to call at its seat. Said out loud because a reservation and a deliberate absence
  // read identically, and the difference is the whole question a reader arrives with.
  // The seat line itself stays in its reserved shape, which is the shape it would
  // take either way — a seat is a seat filled or not, and the board counts it. Said
  // HERE rather than beside that line, because the census below admits seats only.
  // Each seat below receives the boards it writes into, out of the six this
  // composition was handed. A family claims a surface slot, a pane kind, the event
  // kinds whose fold it owns, a sidebar section, and an inline-card body — through
  // its own `register<Family>` entry point, never by editing a shared spine and
  // never through a board's module-scope registrar, which writes into production
  // whatever the caller composed into.
  //
  // WHAT EACH SEAT BELOW TAKES, where a reader can meet it without breaking the block.
  // The composer family claims no surface slot: its body is the composer SEAT under the
  // deck, and its panes are claimed through `panes/index.ts` above. What it does claim
  // is a fold — the approval-flow kinds the approvals pane reads entities from — and
  // three of the sidebar's eight sections, so its seat passes those two boards and no
  // other registry, because those are the only claims it makes.
  //
  // NOTHING BUT SEATS BELOW THIS LINE. A paragraph between two seats reads to a
  // branch exactly like this one does above them, and only one of the two leaves
  // seven one-line diffs at seven distinct positions; `families.seat-board.test.ts`
  // reads the block as a census and refuses anything that is not a seat.
  // T-023p-1C-2 ledger
  registerComposerFamily(projectors, sidebarSections); // T-023p-1C-3 composer
  registerCollaborationFamily(surfaces, sidebarSections, frameBindings); // T-023p-1C-4 collaboration
  registerRepos(sidebarSections, inlineCardSeats); // T-023p-1C-5 repos
  registerWorkflowSurfaces(surfaces); // T-023p-1C-6 workflows
  // T-023p-1C-7 browser-terminal
  // T-023p-1C-8 gallery
}
