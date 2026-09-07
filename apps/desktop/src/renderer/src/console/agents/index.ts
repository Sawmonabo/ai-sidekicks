// The agents family's door.
//
// WHAT IS BEHIND IT
//
// The agent card and its binding vocabulary, the two forms that move a binding
// (attach and the provider-axis switch), the settlement projection those replies are
// read through, the peer-invocation grant, the child-run linkage view, the seat for a
// body another plan authors, and the agent console — the body that composes all of
// them, plus the window frame the second of its two mounts draws around it. The FIRST
// mount draws no frame of this family's: the deck wraps this body in the console's one
// pane chrome, which lives in `seats/` because the deck that provides its host controls
// is itself a view family.
//
// WHY THE AGENT CONSOLE'S BODY IS IN THIS FAMILY AND NOT IN `panes/`
//
// `console/panes/` is composition only: the seat board that names every pane kind and
// the chrome the deck draws around one. A pane BODY belongs to the family whose
// vocabulary it renders, and this one renders nothing else — the card, both mutation
// forms, the settlement projection, the linkage view. It lived under `panes/` while it
// was the only pane, which made `panes/` a family directory with a seat board in it
// and made every one of the body's reaches into this family a cross-family import that
// had to cross this door.
//
// ONE STYLESHEET IS IMPORTED HERE, and the split is along what this door actually
// publishes rather than along the directory tree. `SidekickDefinitionsPage` leaves this
// family through the re-export below, so the settings surface that mounts it reaches
// the component through the initial graph and its sheet has to be there too.
//
// THE OTHER FOUR ENTER AT THE AGENT CONSOLE'S TWO CHUNK ROOTS. Both agent-console
// mounts are loaders, and the console's own components are the only readers of those
// four sheets' selectors — measured, not assumed: no module in the static graph names
// a class any of them declares. Leaving them here charged every session the rules for
// a surface it reaches only by opening the pane or the auxiliary window. They are
// imported from BOTH roots rather than one, because either mount can be the first to
// render the body and neither may render it undressed; the bundler emits one shared
// asset for the pair rather than two copies.
//
// The admitting rule is the collision census, not the directory: a sheet may cross a
// chunk boundary only when no other family declares a class it declares, because load
// order decides equal-specificity conflicts and deferring such a sheet restyles the
// other family (`runs/index.ts` records that happening). None of these four does, per
// `test/console/architecture/stylesheet-selector-owners.test.ts`.

import "./definitions/sidekick-definitions-page.css";

// --- WHAT LEAVES THIS FAMILY -------------------------------------------
//
// Only the symbols a surface outside `agents/` composes. The vocabulary tuples, the
// reading shapes, the catalog selectors, the settlement projection, and the agent
// console's own components are this family's own and are reached deeply from inside
// it — a barrel entry for one of them would be an export nothing outside can name.

// The sidekicks page, which the settings surface mounts. It is a page rather than a
// pane because the design puts a saved sidekick's configuration in settings and
// reaches it from the in-session attach picker, and it crosses a family boundary, so
// it leaves this family through the door rather than by a deep import.
export { SidekickDefinitionsPage } from "./definitions/SidekickDefinitionsPage.js";

// The agent console's two mounts — the deck's pane kind, wearing the shared chrome, and
// the auxiliary window's surface slot, wearing its own heading. Straight from the module
// that DECLARES them rather than through a door of that directory's own, which would be
// the barrel chain `console-no-barrel-chain` fails. `panes/index.ts` calls the pane
// registrar from its own reserved line and `collaboration-family.ts` calls the surface
// one, so the two composition sites reach one module through one door.
export {
  registerAgentConsolePane,
  registerAgentConsoleSurface,
} from "./agent-console/agent-console-mounts.js";
