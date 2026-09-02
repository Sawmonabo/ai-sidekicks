// Where the deck's pane bodies are composed in, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL
//
// `console/families.ts` gives each view family a seat for its SURFACE — the thing
// a route mounts. A family also builds PANES, and the deck's registry is keyed by
// a different closed set, so the same problem returns one level down: six branches
// each need their pane bodies reachable from the entry point, and a single shared
// call site would make five of them conflict.
//
// Same answer, for the same reason: one reserved line per family, replaced only by
// that family. Six branches produce six one-line diffs at six distinct positions
// and none of them conflicts.
//
// WHAT A FAMILY DOES
//
// A family exports `register<Family>Panes(registry: ConsolePaneRegistry): void`
// from its own `index.ts`, claims its pane kinds inside that function, and adds the
// import plus one call DIRECTLY BENEATH its own reserved line. The reserved line
// stays: it names the kinds that seat claims, so a reviewer reads the whole deck
// off this file whether or not the seat is filled, and the six seats keep their
// order without depending on which of them happen to be filled today.
//
// WHAT A FAMILY DOES NOT DO
//
// A family never edits `workspace/seats/pane-registry.ts` or `pane-kinds.ts`. The
// pane-kind set is closed by `Spec-023 §Console Design (Meridian)` and widening it
// is a spec amendment, not a console change; the registry is a shared spine, and a
// six-way concurrent edit to one is a guaranteed conflict — or worse, a merge that
// resolves cleanly while silently dropping one family's registration.
//
// ORDER IS THE SEAT BOARD'S ORDER, NOT PREFERENCE
//
// The lines run in task order, matching `console/families.ts`. Registration order
// is not observable — `registeredPaneKinds()` answers in declaration order — so a
// family that needed to run before another to work would be telling us it has a
// dependency it has not declared.
//
// COMPOSITION ONLY
//
// No logic lands here. If this file ever needs a condition, a try, or a value of
// its own, the thing it is deciding belongs in the family that owns the decision.

import { registerAgentConsolePane } from "./agent-console/index.js";
import type { ConsolePaneRegistry } from "../workspace/index.js";

/**
 * Register every shipped pane body against a registry.
 *
 * Takes the registry rather than reaching for the module-scope singleton, for
 * `registerConsoleFamilies`' reason: a test composes the same bodies into a
 * registry it owns, and an auxiliary window composes a different subset without a
 * second code path.
 */
export function registerConsolePanes(registry: ConsolePaneRegistry): void {
  // T-023p-1C-2 timeline
  // T-023p-1C-3 runs approvals inspector
  // T-023p-1C-4 agent-console
  registerAgentConsolePane(registry);
  // T-023p-1C-5 diff artifact
  // T-023p-1C-6 workflow-run workflow-builder
  // T-023p-1C-7 browser terminal
}
