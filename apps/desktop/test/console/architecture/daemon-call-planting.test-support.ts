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

import { daemonCallSitesIn } from "./daemon-call-sites.js";
import { DaemonMethodConstantIndex } from "./daemon-method-bindings.js";
import { daemonMethodReadings } from "./daemon-read-signal-census.js";

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

/** The sites one planted module declares, resolved through `constants`. */
export function plantedSites(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return daemonCallSitesIn("console/planted/surface.ts", lines.join("\n"), constants);
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
  return plantedSites(
    [
      "export async function performRead(bridge, request, signal: AbortSignal) {",
      ...lines.map((line) => `  ${line}`),
      "}",
    ],
    constants,
  );
}
