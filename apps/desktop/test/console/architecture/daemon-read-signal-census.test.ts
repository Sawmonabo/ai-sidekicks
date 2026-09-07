// The read-versus-record needles, driven against sources whose verdict is known.
//
// THE GATE IS NEXT DOOR AND THIS IS THE INSTRUMENT'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-cancellation-chokepoint.test.ts` makes the
// claim over the real console, and a clean result there is worth nothing until the
// checker is proved to bite. Every case below writes a source the console does not
// contain — the offending shapes included, which is why they cannot be written in the
// gate itself.

import { describe, expect, it } from "vitest";

import { DaemonMethodConstantIndex, daemonCallSitesIn } from "./daemon-call-sites.js";
import {
  classifyDaemonCallSite,
  daemonMethodReadings,
  isReadingResponse,
  signalledRecordOffenders,
  unsignalledReadOffenders,
} from "./daemon-read-signal-census.js";

/** A registry stub carrying one reading row and one recording row. */
const PLANTED_REGISTRY = [
  "export const CONSOLE_DAEMON_METHOD_BINDINGS = Object.freeze({",
  '  "repo.workspaceList": bindDaemonMethod(WorkspaceListRequestSchema, WorkspaceListResponseSchema),',
  '  "session.join": bindDaemonMethod(SessionJoinRequestSchema, SessionJoinResponseSchema),',
  "});",
].join("\n");

const PLANTED_READINGS: ReadonlyMap<string, boolean> = daemonMethodReadings(PLANTED_REGISTRY);

/** An index over the two planted methods, with no constants folded in. */
function emptyIndex(): DaemonMethodConstantIndex {
  return new DaemonMethodConstantIndex([...PLANTED_READINGS.keys()]);
}

/** The sites one planted module declares, resolved through `constants`. */
function plantedSites(
  lines: readonly string[],
  constants: DaemonMethodConstantIndex = emptyIndex(),
): ReturnType<typeof daemonCallSitesIn> {
  return daemonCallSitesIn("console/planted/surface.ts", lines.join("\n"), constants);
}

describe("the response-shape partition", () => {
  it("reads the registry's own binding rather than the method name", () => {
    // The table pairs a method with the schema its answer is parsed against, and that
    // pairing is what says whether the call was a reading. A gate reading the method
    // string would be a naming convention wearing a classifier's clothes.
    expect(PLANTED_READINGS.get("repo.workspaceList")).toBe(true);
    expect(PLANTED_READINGS.get("session.join")).toBe(false);
  });

  it("takes the reading verb as a word, wherever in the operation it sits", () => {
    // The head-position case is real: three driver catalogs answer `ListModelsResult`
    // and its siblings, which a suffix rule misses entirely.
    expect(isReadingResponse("QueueItemListResponseSchema")).toBe(true);
    expect(isReadingResponse("ListModelsResultSchema")).toBe(true);
    expect(isReadingResponse("WorktreeReuseCheckResponseSchema")).toBe(true);
    expect(isReadingResponse("WorkspaceExecutionModeCapabilitiesReadResponseSchema")).toBe(true);
  });

  it("negative control: a word that merely contains a verb is not one", () => {
    // The substring hazard, written as the schema that would exercise it. `Checklist`
    // is one word and `Check` is not a word of it, which is the whole reason the split
    // is on capital boundaries rather than on `includes`.
    expect(isReadingResponse("ChecklistUpdateResponseSchema")).toBe(false);
    expect(isReadingResponse("RunControlAckSchema")).toBe(false);
    expect(isReadingResponse("EphemeralCloneDisposeResponseSchema")).toBe(false);
  });

  it("negative control: the table reader ignores everything that is not a binding", () => {
    // The registry's prose names the factory and a dozen schemas while explaining
    // them, and its neighbours declare object literals of their own.
    expect(
      daemonMethodReadings(
        ['// a row reads `"presence.read": bindDaemonMethod(A, PresenceReadResponseSchema)`.'].join(
          "\n",
        ),
      ).size,
    ).toBe(0);
    expect(
      daemonMethodReadings('const table = { "presence.read": somethingElse(A, B) };').size,
    ).toBe(0);
  });
});

describe("the call-site parse", () => {
  it("reads the method and the signal off a literal call", () => {
    const [site] = plantedSites([
      'const reply = await callDaemon(bridge, "repo.workspaceList", request, { signal });',
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["repo.workspaceList"]);
    expect(site?.carriesSignal).toBe(true);
    expect(site?.line).toBe(1);
  });

  it("takes the signal through an assignment as well as a shorthand", () => {
    const [site] = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: round.signal });',
    ]);
    expect(site?.carriesSignal).toBe(true);
  });

  it("negative control: prose naming the door and the member is not a call", () => {
    // Both needles at once, against the shape every module in this family carries: a
    // header sentence explaining that reads pass `{ signal }` through `callDaemon`.
    expect(
      plantedSites(["// a read reaches `callDaemon(bridge, method, request, { signal })`."]),
    ).toStrictEqual([]);
    expect(plantedSites(['const note = "callDaemon(bridge, method, request)";'])).toStrictEqual([]);
  });

  it("fails closed on an options shape it cannot read", () => {
    // A spread and a held variable each hide the member from this parse, and reporting
    // such a call as stoppable would be the false green the gate exists to prevent.
    const [spread] = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, { ...options });',
    ]);
    expect(spread?.carriesSignal).toBe(false);
    const [held] = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, options);',
    ]);
    expect(held?.carriesSignal).toBe(false);
  });

  it("resolves a method constant declared anywhere in the scan", () => {
    // Two of the console's call sites name a constant another module declares, so the
    // index is folded across the whole tree rather than per module.
    const constants = emptyIndex();
    constants.add('export const LIST_METHOD = "repo.workspaceList";', "console/planted/wire.ts");
    const [site] = plantedSites(["await callDaemon(bridge, LIST_METHOD, request);"], constants);
    expect(site?.resolvedMethods).toStrictEqual(["repo.workspaceList"]);
  });

  it("resolves a constant through the type wrapper its declaration carries", () => {
    // The provider-readiness probe's constant is `"providerAccount.probe" satisfies
    // MutatingDaemonMethod`, and a reader stopping at the wrapper manufactured an
    // offender out of a module doing exactly the right thing.
    const constants = emptyIndex();
    constants.add(
      'export const JOIN_METHOD: "session.join" = "session.join" satisfies SomeTuple;',
      "console/planted/wire.ts",
    );
    const [site] = plantedSites(["await callDaemon(bridge, JOIN_METHOD, request);"], constants);
    expect(site?.resolvedMethods).toStrictEqual(["session.join"]);
  });

  it("refuses a constant two modules bind to two different methods", () => {
    // Guessing between them would report on whichever module the walk reached last.
    const constants = emptyIndex();
    constants.add('const METHOD = "repo.workspaceList";', "console/planted/one.ts");
    constants.add('const METHOD = "session.join";', "console/planted/two.ts");
    expect(constants.resolve("METHOD")).toStrictEqual([]);
  });

  it("resolves a parameter declared as a union of literals", () => {
    const [site] = plantedSites([
      'async function dispatch(method: "session.join" | "repo.workspaceList") {',
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["session.join", "repo.workspaceList"]);
  });

  it("resolves a type parameter's constraint from an inner arrow", () => {
    // The generic binder's shape: the method is the OUTER function's parameter and the
    // arrow that names it declares none, so a reader stopping at the innermost span
    // reported the call as naming nothing.
    const [site] = plantedSites([
      'export function bind<MethodName extends "session.join">(method: MethodName) {',
      "  return async (request) => await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["session.join"]);
  });

  it("resolves the same constraint written as a module-level alias", () => {
    const [site] = plantedSites([
      'type RecordingMethod = "session.join" | "repo.attach";',
      "export function bind<MethodName extends RecordingMethod>(method: MethodName) {",
      "  return async (request) => await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["session.join", "repo.attach"]);
  });

  it("negative control: an unconstrained generic resolves to nothing", () => {
    // The shape the collaboration binder used to carry. Its constraint was the whole
    // registry, which admits reads, so the call could bind one and hand it no signal.
    const [site] = plantedSites([
      "export function bind<MethodName extends ConsoleDaemonMethod>(method: MethodName) {",
      "  return async (request) => await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(site?.resolvedMethods).toStrictEqual([]);
    expect(site !== undefined && classifyDaemonCallSite(site, PLANTED_READINGS)).toBe("unresolved");
  });
});

describe("the two offender readings", () => {
  it("reports a read that was handed no signal — with its line and its reason", () => {
    // THE REGRESSION THIS GATE EXISTS TO PREVENT FROM RETURNING, written as the module
    // it was. The browser pane's admitted-root disclosure read the session's
    // workspaces behind a `cancelled` boolean, which discards an answer and stops
    // nothing.
    const sites = plantedSites([
      "export function useAdmittedRoots(bridge, sessionId) {",
      '  const reply = await callDaemon(bridge, "repo.workspaceList", { sessionId });',
      "}",
    ]);
    expect(unsignalledReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:2 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
    ]);
  });

  it("reports a call whose method it could not resolve", () => {
    const sites = plantedSites([
      "export function bind<MethodName extends ConsoleDaemonMethod>(method: MethodName) {",
      "  return async (request) => await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(unsignalledReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:2 — method resolves to no registered method, so this call could name a read and can be stopped by nothing",
    ]);
  });

  it("reports a record that was handed one", () => {
    // The positive control. A durable act that has reached the daemon has HAPPENED, so
    // a signal on one abandons the console's half of a write mid-flight.
    const sites = plantedSites([
      'await callDaemon(bridge, "session.join", request, { signal: round.signal });',
    ]);
    expect(signalledRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:1 — records session.join and was handed a signal",
    ]);
  });

  it("passes the two compliant shapes", () => {
    // The clean side of both lines, so the readings are proved to admit as well as to
    // refuse — a checker answering the empty array to everything reads like a tree in
    // order.
    const sites = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      'await callDaemon(bridge, "session.join", request);',
    ]);
    expect(unsignalledReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(signalledRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("holds a mixed union to the read rule", () => {
    // A signal cannot be conditional on which arm ran, so a parameter admitting both
    // kinds is a read.
    const sites = plantedSites([
      'async function dispatch(method: "session.join" | "repo.workspaceList") {',
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(sites.map((site) => classifyDaemonCallSite(site, PLANTED_READINGS))).toStrictEqual([
      "read",
    ]);
    expect(unsignalledReadOffenders(sites, PLANTED_READINGS)).toHaveLength(1);
  });
});
