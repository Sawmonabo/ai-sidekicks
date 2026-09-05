// The agents family's door.
//
// WHAT IS BEHIND IT
//
// The agent card and its binding vocabulary, the two forms that move a binding
// (attach and the provider-axis switch), the settlement projection those replies are
// read through, the peer-invocation grant, the child-run linkage view, the seat for a
// body another plan authors, and the agent console — the pane body that composes all
// of them.
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
// EVERY STYLESHEET IN THIS FAMILY IS IMPORTED HERE AND NOWHERE ELSE, so a surface can
// never render one of these components without the CSS that makes it legible, and the
// bundler sees one edge into each sheet rather than one per component.
//
// There are five rather than one, because four sub-modules carry their own: the
// provider switch, the run linkage, the sidekicks page, and the agent console. That is
// a split of the SHEETS and not of the rule — the rule is still one import site, and it
// is this one. The definitions sheet used to be imported from its own page instead,
// which is how one BEM block came to be written across two files with two edges into it.
//
// The sub-modules have no doors of their own — nothing outside `agents/` reaches into
// any of them — so their sheets are imported here rather than from a barrel that
// would exist only to hold a CSS import.

import "./agents.css";
import "./agent-console/agent-console.css";
import "./definitions/definitions-page.css";
import "./provider-switch/provider-switch.css";
import "./run-console/run-console.css";

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
export { SidekickDefinitionsPage } from "./definitions/DefinitionsPage.js";

// The agent console's two mounts. Straight from the module that DECLARES them rather
// than through a door of that directory's own, which would be the barrel chain
// `console-no-barrel-chain` fails. `panes/index.ts` calls the pane registrar from its
// own reserved line and `collaboration-family.ts` calls the surface one, so the two
// composition sites reach one module through one door.
export {
  registerAgentConsolePane,
  registerAgentConsoleSurface,
} from "./agent-console/agent-console-mounts.js";
