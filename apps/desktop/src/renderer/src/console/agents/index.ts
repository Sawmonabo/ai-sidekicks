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
// `session-surfaces-family.ts` imports it eagerly for the agent console's surface
// registration, so every module and every sheet this door reaches statically is on the
// initial graph of every launch. All eight of this family's sheets therefore enter at a
// chunk root instead, and there are THREE such roots — re-derived by listing them rather
// than counted from memory: `agent-console/agent-console-pane-body.ts`,
// `agent-console/agent-console-surface-body.ts`, and
// `provider-switch/provider-switch-body.ts`.
//
// SEVEN OF THE EIGHT AT THE AGENT CONSOLE'S TWO ROOTS. Both agent-console mounts are
// loaders, and the console's own components are the only readers of those seven sheets'
// selectors — measured, not assumed: no module in the static graph names a class any of
// them declares. They are imported from BOTH roots rather than one, because either mount
// can be the first to render the body and neither may render it undressed; the bundler
// emits one shared asset for the pair rather than two copies.
//
// AND THREE OF THOSE SEVEN AGAIN AT THE PROVIDER SWITCH'S OWN ROOT — `agents.css`,
// `axis-field.css`, and `provider-switch/provider-switch.css`, which are the sheets that
// form's subtree draws against and no more; the other four dress surfaces it never
// renders. That root's own header derives the three from the classes its components
// name. A THIRD root is admitted for the same reason the pair is: three alternative
// entries under ONE owning barrel are three ways into one directory rather than three
// owners, which is the single fan-in `test/console/architecture/stylesheet-edges.test.ts`
// admits.
//
// THE EIGHTH AT `definitions/sidekick-definitions-page-body.ts`, which is a root of its own
// because the page it dresses is a SETTINGS section rather than a mount of this family's.
// It sat here, imported beside a re-export of the page, while the settings registration
// could take only a component — and the two together put a page nobody had opened, and the
// rules for it, on every launch. The registration takes a loader now, so both leave.
//
// The admitting rule is the collision census, not the directory: a sheet may cross a
// chunk boundary only when no other family declares a class it declares, because load
// order decides equal-specificity conflicts and deferring such a sheet restyles the
// other family (`runs/index.ts` records that happening). None of these eight does,
// checked against the tree.

// --- WHAT LEAVES THIS FAMILY -------------------------------------------
//
// Only the symbols a surface outside `agents/` composes. The vocabulary tuples, the
// reading shapes, the settlement projection, and the agent console's own components are
// this family's own and are reached deeply from inside it — a barrel entry for one of
// them would be an export nothing outside can name.
//
// THE PROVIDER SWITCH IS THE ONE FORM THAT LEAVES, AND IT LEAVES AS A LOADER. The
// component itself is deliberately absent: a door line for it would be reached
// statically from a door `session-surfaces-family.ts` imports eagerly, which is the
// boundary the loader exists to draw and which a tidy-looking re-export defeats
// silently. What crosses is `loadProviderSwitchBody`, its context type, and the two
// seams the form declares on its props and does not hold — the catalog reading it
// renders the refusal of, and the `agent.configUpdate` latch whose busy state it
// reports. A host outside this family would otherwise compose both again.
//
// THE SIDEKICKS PAGE IS NOT AMONG THEM, and its absence is load-bearing rather than an
// omission. It is mounted from settings, and it left through this door until the
// measurement above: a door another family imports eagerly may not statically reach a
// body that only a settings section mounts, or the boundary that defers it is one the
// bundler resolves into the entry chunk. The page leaves as a CHUNK ROOT instead —
// `definitions/sidekick-definitions-page-body.ts`, named by the loader in
// `console/sidekicks-settings-page.ts` — which is a specifier and not a door line.

// TYPE-ONLY, BOTH OF THEM, which is what keeps the loader below a boundary rather than
// a specifier the bundler resolves into the entry chunk: a type edge is erased before
// the bundler sees it, so neither of these puts a module on this door's graph.
import type { LazyBodyLoader } from "../seats/index.js";
import type { ProviderSwitchBodyContext } from "./provider-switch/provider-switch-body.js";

// The agent console's two mounts — the deck's pane kind, wearing the shared chrome, and
// the auxiliary window's surface slot, wearing its own heading. Straight from the module
// that DECLARES them rather than through a door of that directory's own, which would be
// the barrel chain `console-no-barrel-chain` fails. `panes/index.ts` calls the pane
// registrar from its own reserved line and `session-surfaces-family.ts` calls the surface
// one, so the two composition sites reach one module through one door.
export {
  registerAgentConsolePane,
  registerAgentConsoleSurface,
} from "./agent-console/agent-console-mounts.js";

// This family's sidebar section — the roster, as the column's `agents` body.
//
// Through this door because the file that SEATS it is `session-surfaces-family.ts`, the
// composition site that already names this family: `seats/slots/sidebar-sections.ts` files
// `agents` with the channels family's sections, and that composition may name more
// than one view family where a family door may not. The body itself is this family's,
// because a body belongs to the family whose vocabulary it renders.
export { registerAgentsSidebarSection } from "./agents-sidebar-section.js";

// --- THE PROVIDER SWITCH, FOR A HOST OUTSIDE THIS FAMILY ----------------
//
// The composer mounts this form in its target chip's axis popover, and what it imports
// is the whole set: the loader, its context type, the two factories, and the two holder
// shapes. Their dead-code exemption claims are retired here, which is the one event
// `apps/desktop/AGENTS.md` retires a marker on.
//
// TWO NAMES THAT WERE CLAIMED FOR THAT HOST ARE GONE INSTEAD OF TAGGED, and the reason
// is what building the host established: `AxisDraft` and `DriverCatalogReading` were
// published on the premise that a caller composes the form's props from parts, and a
// caller that takes the two holders whole never names either — `apply` and `catalog`
// arrive already typed. A door line no task will import is deleted rather than carried
// on a marker, so both are, and their declaring modules are read directly by the
// intra-family callers that do need them.

/**
 * The context this body is handed: exactly the form's own props.
 */
export type { ProviderSwitchBodyContext } from "./provider-switch/provider-switch-body.js";

/**
 * The provider switch's chunk, as the console writes a loader.
 *
 * A `LazyBodyLoader` and not a bare arrow, so a host resolves it through the same
 * `seats/lazy-body.ts` contract both boards resolve a registered body through — and so
 * the module's `Body` export name is checked here rather than at the mount.
 */
export const loadProviderSwitchBody: LazyBodyLoader<ProviderSwitchBodyContext> = () =>
  import("./provider-switch/provider-switch-body.js");

// The two seams the form declares and does not hold. Factories, never store internals:
// what leaves is how a host OPENS a catalog reading and how it holds one latch, so the
// read, the scheduler, and the generation round stay this family's to own.
export {
  useAgentBindingSwitch,
  useDriverCatalogReading,
  type AgentBindingSwitchHolder,
  type AgentSwitchRound,
  type DriverCatalogHolder,
} from "./provider-switch/provider-switch-host.js";
