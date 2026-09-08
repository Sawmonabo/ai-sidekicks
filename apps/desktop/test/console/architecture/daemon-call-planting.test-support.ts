// The planted corpus both daemon-call benches drive their needles against.
//
// TWO BENCHES, ONE FIXTURE, AND THE ROLE HAS ONE HOME. `daemon-call-sites.test.ts`
// asks what a call SAYS and `daemon-read-signal-census.test.ts` asks what that makes
// of it; both need the same two-row registry and the same planting helper, and a
// second copy of either would be two registries that agree today. The registry is
// deliberately two rows and not thirty: a control names the row it is about, and a
// fixture that mirrored the real table would go stale the first time the real one
// moved.
//
// EVERY SOURCE HERE IS ONE THE CONSOLE DOES NOT CONTAIN, which is the whole reason
// these live beside the gate rather than in it — the offending shapes cannot be
// written into a tree the gate reads.
//
// AND A MODULE THAT REACHES THE DOOR IMPORTS THE DOOR, which is scaffolding rather
// than subject: `daemon-call-sites.ts` resolves a callee to the binding that bound it,
// so a planted module with no import clause reaches nothing — correctly, and
// uninterestingly, for every case whose subject is the call rather than the clause.
// The import is written once here for the same reason the read helper below is, and
// the cases whose subject IS the clause take the sibling that plants nothing.
//
// IN BOTH SPELLINGS OF THAT BINDING, because a door call is the binding it names: the
// named specifier every shipped consumer writes, and the namespace a module could write
// instead. Both are planted here rather than in one bench, so the site scan, the
// signal reading over it, and the census that classifies the result all drive the
// second shape from the one fixture — which is the whole reason a corpus is shared.

import { daemonCallSitesIn } from "./daemon-call-sites.js";
import { DaemonMethodConstantIndex } from "./daemon-method-constants.js";
import { daemonMethodReadings } from "./daemon-read-signal-census.js";

/** What the scan names every planted module by. */
const PLANTED_MODULE = "console/planted/surface.ts";

/** The clause a module reaching the door carries, as the console's own consumers write it. */
const DOOR_IMPORT = 'import { callDaemon } from "../../bridge/index.js";';

/**
 * The clause a module reaching the door through a NAMESPACE carries.
 *
 * The local name is a fixture spelling and not a rule — the scan resolves the binding
 * rather than the name — so the case that proves exactly that writes its own clause
 * through the sibling that plants nothing, as every claim about a clause does.
 */
const DOOR_NAMESPACE_IMPORT = 'import * as daemonDoor from "../../bridge/index.js";';

/** A registry stub carrying one reading row and one recording row. */
export const PLANTED_REGISTRY: string = [
  "export const CONSOLE_DAEMON_METHOD_BINDINGS = Object.freeze({",
  '  "repo.workspaceList": bindDaemonMethod(WorkspaceListRequestSchema, WorkspaceListResponseSchema),',
  '  "session.join": bindDaemonMethod(SessionJoinRequestSchema, SessionJoinResponseSchema),',
  "});",
].join("\n");

/** The partition those two rows make, read by the real table reader. */
export const PLANTED_READINGS: ReadonlyMap<string, boolean> =
  daemonMethodReadings(PLANTED_REGISTRY);

/** An index over the two planted methods, with no constants folded in. */
export function emptyIndex(): DaemonMethodConstantIndex {
  return new DaemonMethodConstantIndex([...PLANTED_READINGS.keys()]);
}

/**
 * The sites one planted module declares, with the door imported for it.
 *
 * The import occupies line 1, so a case's own first line is line 2 — which is what
 * every reported location below counts from.
 */
export function plantedSites(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return plantedSitesDeclaringImports([DOOR_IMPORT, ...lines], constants);
}

/**
 * The same, for a case whose subject is the module's own import clause.
 *
 * Nothing is planted: an aliased door, a module that imports no door at all, and a
 * constant reached from a named module are each claims ABOUT the clause, and a clause
 * this helper wrote would be a second one beside the one under test.
 */
export function plantedSitesDeclaringImports(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return daemonCallSitesIn(PLANTED_MODULE, lines.join("\n"), constants);
}

/**
 * The sites one planted module declares, reaching the door through a NAMESPACE import.
 *
 * The same corpus and the same helper shape as the named door above, so a case states
 * only which spelling of the binding it is about. The import occupies line 1 here too,
 * which is what every reported location counts from.
 */
export function plantedSitesThroughNamespace(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return plantedSitesDeclaringImports([DOOR_NAMESPACE_IMPORT, ...lines], constants);
}

/**
 * The same source, wrapped in the read helper shape the console actually writes.
 *
 * A signal is a value with a provenance, so a planted call that hands one has to be
 * inside something that was handed one: a top-level `{ signal }` names a binding no
 * module declares, which is exactly the shape the value check refuses. Written once
 * here so a case states the call it is about rather than the scaffolding around it.
 */
export function plantedSitesInReadHelper(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return plantedSites(inReadHelper(lines), constants);
}

/** The same, for a call that reaches the door through a namespace import. */
export function plantedSitesThroughNamespaceInReadHelper(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return plantedSitesThroughNamespace(inReadHelper(lines), constants);
}

/** The read helper both wrappers above plant their case inside, declared once. */
function inReadHelper(lines: readonly string[]): readonly string[] {
  return [
    "export async function performRead(bridge, request, signal: AbortSignal) {",
    ...lines.map((line) => `  ${line}`),
    "}",
  ];
}
