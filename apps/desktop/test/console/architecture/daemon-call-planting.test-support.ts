// The planted corpus every daemon-call bench drives its needles against.
//
// ONE FIXTURE, AND THE ROLE HAS ONE HOME. `daemon-call-sites.test.ts` asks which door a
// call reaches, `daemon-method-resolution.test.ts` what method it names, and
// `daemon-read-signal-census.test.ts` what the registry's partition makes of it; each
// needs the same two-row registry and the same planting helper, and a second copy of
// either would be two registries that agree today. The registry is
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
//
// AND IN BOTH SPELLINGS OF THE READ OFF IT, and both sides of the shadow that hides one.
// A member read through a string key is the same read, and a hoisted `function` of the
// door's own name is a binding the call sees before the import — two shapes that were
// each invisible to every gate at once, so each is planted here and driven by every
// bench rather than written into whichever one noticed it.

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

/**
 * How a module reaches the door off that namespace, in the two spellings of ONE read.
 *
 * A door call is the BINDING it names, so `daemonDoor.callDaemon` and
 * `daemonDoor["callDaemon"]` reach the same export off the same binding and the scan owes
 * both the same answer. Declared here because THREE benches ask it — the site scan, the
 * signal reading over it, and the consumer census — and a bench spelling its own would
 * prove the reading for that spelling and say nothing about the other, which is exactly
 * how the bracketed form stayed outside the site scan AND the pinned consumer count at
 * once.
 *
 * Written against the namespace clause above, whose local name is a fixture spelling
 * rather than a rule. A key that is not a literal is deliberately absent: `daemonDoor[x]`
 * names no member this scan can resolve, so it is a non-match and the case that says so
 * writes it in the bench that makes that claim.
 */
export const NAMESPACE_DOOR_CALLEES: readonly string[] = [
  "daemonDoor.callDaemon",
  'daemonDoor["callDaemon"]',
];

/**
 * A module whose inner `function callDaemon` SHADOWS the door it imports.
 *
 * THREE CALLS AND ONE OF THEM IS THE DOOR. The two inside `withLocalHelper` are the local
 * declaration's — a function declaration binds over the whole scope that contains it, so
 * the call written ABOVE it resolves to it exactly as the one below does — and the call
 * in the sibling function is the import's, which is the half a fail-closed rule could
 * quietly lose. A scope builder recording only variables and binding elements resolved
 * all three to the import and reported the two local ones as unsignalled daemon reads.
 *
 * Held here because both benches drive it: one asks which sites the scan produces, the
 * other what the census then makes of them. Planted through `plantedSites`, so the door
 * import is line 1 and the three calls sit at lines 3, 7 and 10.
 */
export const DOOR_SHADOWED_BY_FUNCTION_DECLARATION: readonly string[] = [
  "export function withLocalHelper(bridge, request) {",
  '  callDaemon(bridge, "repo.workspaceList", request);',
  "  function callDaemon(door, method, payload) {",
  "    return door.send(method, payload);",
  "  }",
  '  callDaemon(bridge, "repo.workspaceList", request);',
  "}",
  "export async function readAdmittedRoots(bridge, request, signal: AbortSignal) {",
  '  return await callDaemon(bridge, "repo.workspaceList", request, { signal });',
  "}",
];

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

/**
 * The door's own name under each transparent wrapper, one spelling per member.
 *
 * THE CLOSED LIST IS `daemon-method-literals.ts`', and this is one call written through
 * each of its five: a parenthesis, `as`, `satisfies`, an angle-bracket `<T>` assertion and
 * a non-null `!`. Every one of them is a callee the emitter hands the same function, and a
 * scan that resolved the WRAPPER instead of what it wraps found no door in any of them —
 * so the module stayed a counted consumer through its named import while the call it makes
 * contributed no site and passed every signal check by not existing.
 *
 * Declared here rather than in one bench because two of them ask it — the site scan and
 * the consumer census — and a bench spelling its own would prove the reading for the
 * spelling it happened to write.
 */
export const TRANSPARENTLY_WRAPPED_DOOR_CALLEES: readonly string[] = [
  "(callDaemon)",
  "(callDaemon as typeof callDaemon)",
  "(callDaemon satisfies typeof callDaemon)",
  "(<typeof callDaemon>callDaemon)",
  "callDaemon!",
];

/**
 * The same wrappers around the NAMESPACE a door read steps off, which is the other
 * position a callee resolves a binding at.
 *
 * `daemonDoor.callDaemon` is a member read, and the object it reads off is resolved
 * exactly as a bare callee is — so a wrapper there was the same hole one node deeper, and
 * `(daemonDoor as typeof daemonDoor).callDaemon(…)` reached no scan at all. Written
 * against the namespace clause above, whose local name is a fixture spelling and not a
 * rule.
 */
export const WRAPPED_NAMESPACE_DOOR_CALLEES: readonly string[] = [
  "(daemonDoor).callDaemon",
  "(daemonDoor as typeof daemonDoor).callDaemon",
  "daemonDoor!.callDaemon",
  '(daemonDoor satisfies typeof daemonDoor)["callDaemon"]',
];

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
