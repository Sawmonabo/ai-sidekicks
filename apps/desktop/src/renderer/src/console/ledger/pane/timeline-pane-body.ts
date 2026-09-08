// The timeline pane's body, as the deck's registry loads it, and the root of its chunk.
//
// A LOADER-BACKED BODY, on the product question `apps/desktop/AGENTS.md` states the rule
// on: is this painted before a person acts? The console opens on the `sessions`
// destination (`routing/routes.ts`' `DEFAULT_ROUTE`), so every pane in the deck — this
// one included — is reached by opening a session, which is an act. It was the one
// registration on the deck's board still handed a component while the other ten named a
// chunk, and the difference was measured rather than argued: the pane, its feed, its
// window and structure derivations, the cards the rows render through, and the markdown
// and ANSI renderers behind those cards were the largest single block on the renderer's
// initial import graph, against a budget (`Spec-023 §Console Design (Meridian)`
// §Budgets) the console was over.
//
// THE ROW SEAT IS FILLED HERE BECAUSE THIS CHUNK IS WHAT READS IT. `TimelinePane.tsx` is
// the only module anywhere that calls `timelineRowRenderer()`, so the seat's reader and
// the seat's shell now arrive together: filling it from `registerLedger` instead put the
// whole card subtree — and every markdown dependency behind it — on the initial graph for
// the sake of a seat nothing outside this chunk reads. The two calls run at module scope
// and not from a registrar, which is what makes that true: a function the family's door
// called would be an edge from the door to these modules again, which is the edge this
// boundary exists to remove. Once per realm is also exactly the right number — the seat
// is a process-wide single slot rather than one of the composed boards, the calls are
// idempotent under its owner scoping, and a suite that wants the rows without the pane
// around them calls `registerFixtureShellRows` itself (`test/console/accessibility/
// ledger-axe.test.tsx` does).
//
// AND BOTH CALLS DIE WITH THE SHELL, exactly as they did at the door:
// `seats/timeline-row-slot.ts` states the absorb-by-import rule, and the change that
// registers the timeline subtree's real rows deletes these two lines with the modules
// they name.
//
// WHY THIS DIRECTORY IS INSIDE THE FAMILY, carried here from the door this module
// replaced. The pane body is ledger view code: the feed, the window derivations, the find
// and replay acts, the row host. It lived under `panes/` while `panes/` was read as
// "where pane bodies go", and that directory is a COMPOSITION SITE — the layering gate
// subtracts it from both endpoints of the view-family rules so the one file whose job is
// to name every family can name them. The whole of this body sat behind that
// subtraction — every module the four sub-modules below hold, which is the largest
// directory in the family — so the DAG rule the whole concurrent build rests on
// quantified over everything except it. Stated without a figure deliberately: a count
// here would be a claim about a tree that grows every time a lane lands, and its going
// stale would be invisible. `panes/` now holds its composition file and nothing else.
//
// FOUR SUB-MODULES AND THE PANE ITSELF. `window/` derives which rows this pane holds,
// `find/` decides which of them a person is asking for, `replay/` decides which of them a
// position lets through, and `feed/` composes the three into the surface a reader
// scrolls.
//
// A SUB-MODULE PUBLISHES A DOOR ONLY WHERE ONE HAS READERS — the family's one criterion,
// stated the same way in `ledger/cards/index.ts` and `ledger/structure/index.ts`, and it
// is READERS and not directories: `window/` is read from three of them, `find/` and
// `replay/` from one apiece, and all three carry a door because every one of those
// readers is a module other than the door that declares them. `feed/` publishes none,
// because the one name that leaves it is read by exactly one module — `TimelinePane.tsx`,
// beside this one. THIS directory carries no door either, and by that same criterion: the
// one name that used to leave it, `TimelinePane`, was read by the family door alone, and
// the family door names this module's specifier now rather than a component — so a door
// here would publish a name no module outside the directory reaches, which is a dead
// export the barrel census fails and an orphan the layering gate reports.
//
// Named `Body` because `seats/lazy-body.ts` fixes the export name a loader resolves.

import { createElement } from "react";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
import { registerFixtureShellRowFooter } from "../cards/shell/FixtureShellRowFooter.js";
import { registerFixtureShellRows } from "../cards/shell/FixtureShellRows.js";
import { TimelinePane } from "./TimelinePane.js";

registerFixtureShellRows();
registerFixtureShellRowFooter();

/**
 * The ledger, at an address the deck resolved to this kind.
 *
 * The narrowing and the mismatch refusal are `paneBodyForKind`'s, for the reason every
 * other pane body gives about them: six families writing that comparison themselves is
 * six answers to one question, and a mismatched arm is a rendered refusal rather than a
 * throw because one bad layout row must lose that row and not the deck. `createElement`
 * rather than JSX: this is a `.ts` module, and the naming rule reserves `.tsx` for a
 * single PascalCase component per file.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "timeline",
  (context) => createElement(TimelinePane, { context }),
);
