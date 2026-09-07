// The read-versus-record needles, driven against sources whose verdict is known.
//
// THE GATE IS NEXT DOOR AND THIS IS THE INSTRUMENT'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-signal-chokepoint.test.ts` makes the claim
// over the real console, and a clean result there is worth nothing until the checker
// is proved to bite. Every case below writes a source the console does not contain —
// the offending shapes included, which is why they cannot be written in the gate
// itself.
//
// THE THREE MODULES ARE DRIVEN TOGETHER because the claim is a composition of them:
// `daemon-method-bindings.ts` says what a name is bound to, `daemon-call-sites.ts`
// reads the call, and `daemon-read-signal-census.ts` decides what that makes of it.
// A control that exercised one in isolation would pass over exactly the seams where
// the four defects this bench now pins actually lived.

import { describe, expect, it } from "vitest";

import { daemonCallSitesIn } from "./daemon-call-sites.js";
import { DaemonMethodConstantIndex } from "./daemon-method-bindings.js";
import {
  classifyDaemonCallSite,
  daemonMethodReadings,
  mixedMethodOffenders,
  stoppableRecordOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";
import { READING_VERBS, answersReadingResponse, namesReadingVerb } from "./daemon-reading-verbs.js";

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
    expect(namesReadingVerb("QueueItemListResponseSchema")).toBe(true);
    expect(namesReadingVerb("ListModelsResultSchema")).toBe(true);
    expect(namesReadingVerb("WorktreeReuseCheckResponseSchema")).toBe(true);
    expect(namesReadingVerb("WorkspaceExecutionModeCapabilitiesReadResponseSchema")).toBe(true);
  });

  it("negative control: a word that merely contains a verb is not one", () => {
    // The substring hazard, written as the schema that would exercise it. `Checklist`
    // is one word and `Check` is not a word of it, which is the whole reason the split
    // is on capital boundaries rather than on `includes`.
    expect(namesReadingVerb("ChecklistUpdateResponseSchema")).toBe(false);
    expect(namesReadingVerb("RunControlAckSchema")).toBe(false);
    expect(namesReadingVerb("EphemeralCloneDisposeResponseSchema")).toBe(false);
  });

  it("negative control: a fourth reading verb moves both gates at once", () => {
    // THE SINGLE SOURCE, PROVED SINGLE. The suffix spelling this bench's neighbour
    // classifies repos wrappers with and the word spelling the registry rows are
    // classified with were two hand-written lists of the same closed set, so a verb
    // added to one left the other reading it as a mutation. One added verb has to move
    // both derivations or the set is not really one set.
    expect(namesReadingVerb("WorkspaceProbeResponseSchema")).toBe(false);
    expect(answersReadingResponse("WorkspaceProbeResponse")).toBe(false);
    const widened = [...READING_VERBS, "Probe"];
    expect(namesReadingVerb("WorkspaceProbeResponseSchema", widened)).toBe(true);
    expect(answersReadingResponse("WorkspaceProbeResponse", widened)).toBe(true);
    // And the widening is real rather than a rule that admits everything.
    expect(namesReadingVerb("EphemeralCloneDisposeResponseSchema", widened)).toBe(false);
    expect(answersReadingResponse("EphemeralCloneDisposeResponse", widened)).toBe(false);
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
    expect(site?.signalArgument).toBe("present");
    expect(site?.line).toBe(1);
  });

  it("takes the signal through an assignment as well as a shorthand", () => {
    const [site] = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: round.signal });',
    ]);
    expect(site?.signalArgument).toBe("present");
  });

  it("negative control: prose naming the door and the member is not a call", () => {
    // Both needles at once, against the shape every module in this family carries: a
    // header sentence explaining that reads pass `{ signal }` through `callDaemon`.
    expect(
      plantedSites(["// a read reaches `callDaemon(bridge, method, request, { signal })`."]),
    ).toStrictEqual([]);
    expect(plantedSites(['const note = "callDaemon(bridge, method, request)";'])).toStrictEqual([]);
  });

  it("negative control: the door reached under an import alias is still the door", () => {
    // THE SHAPE THAT DROPPED EVERY CALL IN A MODULE. `daemon-reply-chokepoint` counts
    // an aliased import as a consumer, so the module stayed in the census while this
    // scan — matching the exported spelling against the callee — contributed none of
    // its calls, and the signal check reported a clean result over nothing.
    const sites = plantedSites([
      'import { callDaemon as send } from "../../bridge/index.js";',
      "export async function readAdmittedRoots(bridge, sessionId) {",
      '  return await send(bridge, "repo.workspaceList", { sessionId });',
      "}",
    ]);
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([["repo.workspaceList"]]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:3 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
    ]);
  });

  it("reports an options argument it cannot read as its own answer", () => {
    // A spread and a held variable each hide the member from this parse. Answering
    // `absent` for them was fail-closed for a read and fail-OPEN for a record, whose
    // rule is that no signal was passed — so the reading is a third value.
    const [spread] = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, { ...options });',
    ]);
    expect(spread?.signalArgument).toBe("opaque");
    const [held] = plantedSites([
      'await callDaemon(bridge, "repo.workspaceList", request, options);',
    ]);
    expect(held?.signalArgument).toBe("opaque");
    const [read] = plantedSites(['await callDaemon(bridge, "session.join", request, { cause });']);
    expect(read?.signalArgument).toBe("absent");
  });

  it("resolves a method constant another module declares, reached by import", () => {
    // Two of the console's call sites name a constant `agents/agent-wire.ts` declares.
    // The import is the binding this module has; the index is asked for the name that
    // import came from, rather than for whatever spelling the call used.
    const constants = emptyIndex();
    constants.add('export const LIST_METHOD = "repo.workspaceList";', "console/planted/wire.ts");
    const [site] = plantedSites(
      [
        'import { LIST_METHOD } from "./wire.js";',
        "await callDaemon(bridge, LIST_METHOD, request);",
      ],
      constants,
    );
    expect(site?.resolvedMethods).toStrictEqual(["repo.workspaceList"]);
  });

  it("resolves a constant through the type wrapper its declaration carries", () => {
    // The provider-readiness probe's constant is `"providerAccount.probe" satisfies
    // MutatingDaemonMethod`, and a reader stopping at the wrapper manufactured an
    // offender out of a module doing exactly the right thing.
    const [site] = plantedSites([
      'const JOIN_METHOD: "session.join" = "session.join" satisfies MutatingDaemonMethod;',
      "await callDaemon(bridge, JOIN_METHOD, request);",
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["session.join"]);
  });

  it("refuses a constant two modules bind to two different methods", () => {
    // Guessing between them would report on whichever module the walk reached last.
    const constants = emptyIndex();
    constants.add('const METHOD = "repo.workspaceList";', "console/planted/one.ts");
    constants.add('const METHOD = "session.join";', "console/planted/two.ts");
    expect(constants.resolve("METHOD")).toStrictEqual([]);
  });

  it("negative control: the nearest binding wins over the one further out", () => {
    // THE SHADOW THE NAME INDEX HID. The old resolver read the enclosing parameters
    // and then a repository-wide fold keyed by the name alone, so an inner binding was
    // invisible and this call classified from the OUTER parameter — a record, exempt
    // from the signal rule, while the line it actually makes is a read.
    const sites = plantedSites([
      'export async function dispatch(method: "session.join", bridge, request) {',
      "  {",
      '    const method = "repo.workspaceList";',
      "    return await callDaemon(bridge, method, request);",
      "  }",
      "}",
    ]);
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([["repo.workspaceList"]]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:4 — method reads (repo.workspaceList) and was handed no signal",
    ]);
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

describe("the three offender readings", () => {
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
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:2 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
    ]);
  });

  it("reports a call whose method it could not resolve", () => {
    const sites = plantedSites([
      "export function bind<MethodName extends ConsoleDaemonMethod>(method: MethodName) {",
      "  return async (request) => await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:2 — method resolves to no registered method, so this call could name a read and can be stopped by nothing",
    ]);
  });

  it("reports a record that was handed one", () => {
    // The positive control. A durable act that has reached the daemon has HAPPENED, so
    // a signal on one abandons the console's half of a write mid-flight.
    const sites = plantedSites([
      'await callDaemon(bridge, "session.join", request, { signal: round.signal });',
    ]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:1 — records session.join and was handed a signal",
    ]);
  });

  it("negative control: a record whose options this parse cannot read is reported too", () => {
    // THE ARM A BOOLEAN LOST. Neither line shows that no signal was passed, and the
    // record rule is that the call SHOWS it carries none — so reading them as `absent`
    // let a held options bag hand a durable mutation something that abandons it.
    const sites = plantedSites([
      'await callDaemon(bridge, "session.join", request, options);',
      'await callDaemon(bridge, "session.join", request, { ...options });',
    ]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:1 — records session.join and was handed options this parse cannot read, so nothing here shows it carries no signal",
      "console/planted/surface.ts:2 — records session.join and was handed options this parse cannot read, so nothing here shows it carries no signal",
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
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(mixedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: a union naming both kinds is reported whatever it was handed", () => {
    // THE ARM THAT PASSED BOTH READINGS. Read as `"read"`, the signal satisfied the
    // read rule while the record reading skipped the site — its verdict was not
    // `"record"` — so a signal that abandons a durable mutation went unreported.
    const sites = plantedSites([
      'async function dispatch(method: "session.join" | "repo.workspaceList", round) {',
      "  return await callDaemon(bridge, method, request, { signal: round.signal });",
      "}",
    ]);
    expect(sites.map((site) => classifyDaemonCallSite(site, PLANTED_READINGS))).toStrictEqual([
      "mixed",
    ]);
    expect(mixedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:2 — method names both a read (repo.workspaceList) and a record (session.join); split the call or narrow the union so one call is one kind",
    ]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: an unsignalled mixed union is reported once, by its own reading", () => {
    // The other half of the same line: the mixed reading owns the site whatever the
    // options said, so the read reading does not double-report it.
    const sites = plantedSites([
      'async function dispatch(method: "session.join" | "repo.workspaceList") {',
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(mixedMethodOffenders(sites, PLANTED_READINGS)).toHaveLength(1);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });
});
