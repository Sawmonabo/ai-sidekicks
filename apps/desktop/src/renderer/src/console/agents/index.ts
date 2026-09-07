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
// NO STYLESHEET IS IMPORTED HERE, and the reason is what this door is REACHED BY.
// `collaboration-family.ts` imports it eagerly for the agent console's surface
// registration, so every module and every sheet this door reaches statically is on the
// initial graph of every launch. All five of this family's sheets therefore enter at a
// chunk root instead.
//
// FOUR OF THEM AT THE AGENT CONSOLE'S TWO ROOTS. Both agent-console mounts are loaders,
// and the console's own components are the only readers of those four sheets' selectors —
// measured, not assumed: no module in the static graph names a class any of them declares.
// They are imported from BOTH roots rather than one, because either mount can be the first
// to render the body and neither may render it undressed; the bundler emits one shared
// asset for the pair rather than two copies.
//
// THE FIFTH AT `definitions/sidekick-definitions-page-body.ts`, which is a root of its own
// because the page it dresses is a SETTINGS section rather than a mount of this family's.
// It sat here, imported beside a re-export of the page, while the settings registration
// could take only a component — and the two together put a page nobody had opened, and the
// rules for it, on every launch. The registration takes a loader now, so both leave.
//
// The admitting rule is the collision census, not the directory: a sheet may cross a
// chunk boundary only when no other family declares a class it declares, because load
// order decides equal-specificity conflicts and deferring such a sheet restyles the
// other family (`runs/index.ts` records that happening). None of these five does, per
// `test/console/architecture/stylesheet-selector-owners.test.ts`.

// --- WHAT LEAVES THIS FAMILY -------------------------------------------
//
// Only the symbols a surface outside `agents/` composes. The vocabulary tuples, the
// reading shapes, the catalog selectors, the settlement projection, and the agent
// console's own components are this family's own and are reached deeply from inside
// it — a barrel entry for one of them would be an export nothing outside can name.
//
// THE SIDEKICKS PAGE IS NOT AMONG THEM, and its absence is load-bearing rather than an
// omission. It is mounted from settings, and it left through this door until the
// measurement above: a door another family imports eagerly may not statically reach a
// body that only a settings section mounts, or the boundary that defers it is one the
// bundler resolves into the entry chunk. The page leaves as a CHUNK ROOT instead —
// `definitions/sidekick-definitions-page-body.ts`, named by the loader in
// `console/sidekicks-settings-page.ts` — which is a specifier and not a door line.

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
