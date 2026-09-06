// The console's family vocabulary, for `.dependency-cruiser.mjs` beside it.
//
// SPLIT FROM THE RULE SET BECAUSE THEY ARE TWO JOBS AND TWO EDITORS. This half says what
// the families ARE — where each one lives, what sits above it, which single modules are
// named exemptions — and it is what a branch landing a view family touches. The half next
// door says what is FORBIDDEN over that vocabulary, and it is what a branch tightening a
// rule touches. Held in one file the two grew past four hundred lines together, and every
// family branch and every rule change collided in the same place.
//
// Every name here is exported because the rule set is its only reader: a name it stops
// using is a name to delete rather than one to hide.

/** Console family homes, low to high. A family may import any home below it and none above. */
export const CONSOLE = "^src/renderer/src/console";

/**
 * The shell that MOUNTS the console, which is why it is a home here and not a literal.
 *
 * It is not a console family and sits on no rung of the ladder below — it composes
 * console seats, so it is above the whole DAG, and the only rule that names it forbids
 * an edge INTO it. It is exported from here anyway because this file is where a home
 * lives: spelled at its one rule as a string literal it was the one family home a
 * `grep` of this vocabulary could not find, and a rename of that directory would have
 * left the rule silently matching nothing.
 */
export const SHELL = "^src/renderer/src/shell/";

// `core/` is the DAG floor: the caps and tripwires, the refusal vocabulary, the clock, the
// keyed registry, the emitter, the wire-string readers. Nothing below it, so its rule below
// is the only one that forbids every other family at once. The residents are read off the
// directory rather than listed here — a roster in a comment is a closed set whose second
// home nothing keeps current.
export const CORE = `${CONSOLE}/core/`;
export const TOKENS = `${CONSOLE}/tokens/`;
export const ROUTING = `${CONSOLE}/routing/`;
export const PRIMITIVES = `${CONSOLE}/primitives/`;
export const STATE = `${CONSOLE}/(store|persistence)/`;
export const BRIDGE = `${CONSOLE}/bridge/`;
// `seats/` holds the contracts through which view families hand each other bodies — the
// pane registry and its kinds and addresses, the composer seat, sidebar sections, the
// timeline row slot, the inline-card seats. It sits HERE, directly above `bridge/`,
// because that is the highest family a seat imports; and below `palette/` and `frame/`
// because the frame composes the pane-registry singleton and a seat reaches for neither.
// It lived at `workspace/seats/` until this position was named, which made the frame
// import a VIEW family — the edge the `console-layering-view-families` rule below now
// forbids outright.
export const SEATS = `${CONSOLE}/seats/`;
export const PALETTE = `${CONSOLE}/palette/`;
export const FRAME = `${CONSOLE}/frame/`;

// The composition sites: the root modules enumerated below, plus `panes/index.ts`.
// Their whole job is to name every view family, so they are the one place a
// downward-only ladder cannot apply — they sit above every family by construction. They
// are named here so the view-family rule below can subtract them rather than report the
// console's own entry wiring as a violation.
//
// ENUMERATED RATHER THAN `[^/]+$`, which is what this pattern was and what made the
// exemption one `git mv` wide. A family that `console-view-family-isolation` stopped
// from importing a sibling could import both families from a NEW file at the console
// root and the gate stayed green, because the wildcard admitted any root file as a
// composition site — subtracted from the view-family set and from both endpoints of the
// isolation rule at once. The enumeration makes a second root module a gate failure that
// names itself.
//
// A FAMILY THAT LANDS ITS OWN ROOT REGISTRAR ADDS ONE ALTERNATIVE HERE and rewrites no
// prose anywhere: this comment, `apps/desktop/AGENTS.md`, and the isolation rule below
// all say "the enumerated root modules" rather than a count, so the six concurrent
// family branches each produce a one-line, self-naming diff at this list.
//
// `console-env.d.ts` is the console root's other resident and is deliberately absent.
// It declares ambient types: no module imports it and it imports none, so it is an
// endpoint of no edge any rule here judges, and `no-orphans` exempts declaration files
// by extension already. Co-located tests are absent for the stronger reason that
// `options.exclude` removes them from the graph before any rule runs.
export const COMPOSITION_ROOT_FILES = `${CONSOLE}/(families)\\.ts$`;
// The pane board is the FILES directly under `panes/`, not the directory. After the
// pane-body rule below, `panes/` holds composition and nothing else, so a
// `panes/<something>/` subtree is not a composition site and must not inherit the
// exemption one gets: with the directory spelled here, a pane body parked under
// `panes/runs/` would have been subtracted from the view-family set on both endpoints
// and could import any view family it liked.
export const COMPOSITION_PANE_BOARD = `${CONSOLE}/panes/[^/]+\\.tsx?$`;

/** Any module under a subdirectory of the pane board — the shape that is forbidden. */
export const PANE_BOARD_SUBDIRECTORY = `${CONSOLE}/panes/[^/]+/`;

/**
 * Test scaffolding, subtracted from the DOOR rule alone and from no other rule here.
 *
 * A `.test-support.*` module is a module like any other — `apps/desktop/AGENTS.md`
 * §Module shape says so — and it stays a subject of every rule in this file that is
 * about module SHAPE: cycles, orphans, the process boundary, the family ordering, and
 * view-family isolation all still bite it. What it cannot be a subject of is the rule
 * that says "import the door instead", because two gates would then contradict each
 * other and leave the module class with no legal form at all:
 * `test/console/architecture/barrel-census.test.ts` fails a door line whose only
 * reader is a test, and the symbols a harness reaches for are exactly that class —
 * `createLiveBridge`, which the shipped console resolves inside the bridge family, and
 * the per-family scenario seats, which `bridge/index.ts`'s own header records as
 * deliberately unpublished so that six family branches each edit one file rather than
 * one shared door.
 *
 * The narrowness is the repair. This subtraction replaces an `options.exclude` entry
 * that removed `.test-support.*` from the graph outright — which took it out of every
 * rule at once, including the orphan rule whose own comment explains why it must stay
 * in — and which landed in the same change as the one import it made legal.
 */
export const TEST_SUPPORT_MODULES = "\\.test-support\\.(ts|tsx)$";

/**
 * The one cross-process leaf: types and pure functions main, preload and the renderer
 * all need.
 *
 * Named here because two rules scope to it and they say opposite things — what it may
 * import, and who may import it. The console reaches it through the layer family that
 * owns the concern, never from a view family: `core/` is where a wire string, a
 * refusal code or a stringifier lands, so one console module knows the shared shape
 * and everything above it reads the console's own.
 */
export const CROSS_PROCESS_SHARED = "^src/shared/";

/** Every family door, and only a family door — a sub-module door is one segment deeper. */
export const CONSOLE_FAMILY_DOORS = `${CONSOLE}/[^/]+/index\\.ts$`;

/**
 * Every barrel under `console/` — a family door and a sub-module door alike.
 *
 * Two alternatives rather than one `(?:[^/]+/)*` because dependency-cruiser refuses a rule
 * whose regular expression has a star height above one: a quantified group containing its own
 * quantifier is the catastrophic-backtracking shape, and the cruise bails on it outright
 * rather than running slowly. Measured — the nested form fails with "has an unsafe regular
 * expression. Bailing out."
 */
export const CONSOLE_BARRELS = [`${CONSOLE}/index\\.ts$`, `${CONSOLE}/.+/index\\.ts$`];

/** Every layer family, low to high — the closed set the DAG orders. */
export const LAYER_FAMILIES = [
  CORE,
  TOKENS,
  ROUTING,
  PRIMITIVES,
  STATE,
  BRIDGE,
  SEATS,
  PALETTE,
  FRAME,
];

/**
 * A VIEW family is any console home that is not a layer family and not a composition site.
 *
 * Stated as the COMPLEMENT rather than as a list of directory names, because a list is the
 * exact thing that failed here: the ladders below stopped at `frame/`, so no rule named the
 * view families and `frame/` → `workspace/` passed a gate whose own standard forbids it. A
 * list would have to be extended by each of the seven family branches, and the one that
 * forgot would reopen the same hole silently. The complement needs no line at all when a
 * family lands, and it cannot be forgotten.
 */
export const VIEW_FAMILIES = {
  path: `${CONSOLE}/`,
  pathNot: [...LAYER_FAMILIES, COMPOSITION_PANE_BOARD, COMPOSITION_ROOT_FILES],
};

/** Everything strictly above each family, as one alternation. */
export const ABOVE_CORE = [TOKENS, ROUTING, PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];
export const ABOVE_TOKENS = [ROUTING, PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];
export const ABOVE_ROUTING = [PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];
export const ABOVE_PRIMITIVES = [STATE, BRIDGE, SEATS, PALETTE, FRAME];
export const ABOVE_STATE = [BRIDGE, SEATS, PALETTE, FRAME];
export const ABOVE_BRIDGE = [SEATS, PALETTE, FRAME];
export const ABOVE_SEATS = [PALETTE, FRAME];
export const ABOVE_PALETTE = [FRAME];

/** One forbidden rule per family: an edge from that family to anything above it. */
export function upwardEdge(family, fromPath, toPaths) {
  return {
    name: `console-layering-${family}`,
    comment:
      `\`console/${family}\` sits below the families it imported. Hoist the symbol down to the ` +
      `lowest family that needs it; never deep-import around the edge.`,
    severity: "error",
    from: { path: fromPath },
    to: { path: toPaths },
  };
}
