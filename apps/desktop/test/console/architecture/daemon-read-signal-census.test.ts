// The read-versus-record partition and its four offender readings, driven against
// sources whose verdict is known.
//
// THE GATE IS NEXT DOOR AND THIS IS THE CLASSIFIER'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-signal-chokepoint.test.ts` makes the claim
// over the real console, and a clean result there is worth nothing until the checker
// is proved to bite. Every case below writes a source the console does not contain —
// the offending shapes included, which is why they cannot be written in the gate
// itself.
//
// WHAT A CALL SAYS IS THE NEIGHBOURING BENCH'S SUBJECT. `daemon-call-sites.test.ts`
// pins the method resolution and the signal-value reading; this file starts from a
// site and asks what the registry's partition makes of it, and what each of the four
// readings then owes. The two share one planted corpus so neither drifts from the
// other, and each site is owned by exactly one reading — which is itself a claim the
// cases below make rather than assume.

import { describe, expect, it } from "vitest";

import {
  PLANTED_READINGS,
  PLANTED_REGISTRY,
  plantedSites,
  plantedSitesInReadHelper,
} from "./daemon-call-planting.test-support.js";
import {
  classifyDaemonCallSite,
  daemonMethodReadings,
  mixedMethodOffenders,
  stoppableRecordOffenders,
  unresolvedMethodOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";
import { READING_VERBS, answersReadingResponse, namesReadingVerb } from "./daemon-reading-verbs.js";

describe("the response-shape partition", () => {
  it("reads the registry's own binding rather than the method name", () => {
    // The table pairs a method with the schema its answer is parsed against, and that
    // pairing is what says whether the call was a reading. A gate reading the method
    // string would be a naming convention wearing a classifier's clothes.
    expect(PLANTED_READINGS.get("repo.workspaceList")).toBe(true);
    expect(PLANTED_READINGS.get("session.join")).toBe(false);
    expect(daemonMethodReadings(PLANTED_REGISTRY).size).toBe(2);
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

  it("negative control: a schema renamed by the import clause is classified as exported", () => {
    // THE RENAME THAT DELETED THE VERB. The operation a schema names is the contracts
    // package's, and a row reaches it through whatever the registry's own clause bound
    // it to — so `WorkspaceListResponseSchema as WorkspaceResponseSchema` leaves the
    // whole classification outside the identifier the row carries, `List` goes with
    // it, and a read is exempted from the signal rule by a rename in a file the rule
    // is not about.
    const aliased = daemonMethodReadings(
      [
        "import {",
        "  SessionJoinResponseSchema,",
        "  WorkspaceListResponseSchema as WorkspaceResponseSchema,",
        '} from "@ai-sidekicks/contracts";',
        "export const CONSOLE_DAEMON_METHOD_BINDINGS = Object.freeze({",
        '  "repo.workspaceList": bindDaemonMethod(WorkspaceListRequestSchema, WorkspaceResponseSchema),',
        '  "session.join": bindDaemonMethod(SessionJoinRequestSchema, SessionJoinResponseSchema),',
        "});",
      ].join("\n"),
    );
    expect(aliased.get("repo.workspaceList")).toBe(true);
    // And the rename is really a rename rather than a rule that admits everything: an
    // unaliased record still records, and a local spelling with no clause behind it is
    // classified as itself.
    expect(aliased.get("session.join")).toBe(false);
    expect(daemonMethodReadings(PLANTED_REGISTRY).get("repo.workspaceList")).toBe(true);
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

describe("the four offender readings", () => {
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
      'console/planted/surface.ts:3 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
    ]);
  });

  it("negative control: a read handed a signal that is not its round's is reported", () => {
    // THE HOLE THE KEY CHECK LEFT, at the reading that has to close it. The call SHOWS
    // a member named `signal` and shows nothing that could stop this read, so the read
    // rule is unsatisfied — a controller minted beside the call is aborted by nobody.
    const sites = plantedSitesInReadHelper([
      "const controller = new AbortController();",
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: controller.signal });',
    ]);
    expect(sites.map((site) => site.signalArgument)).toStrictEqual(["unrecognised"]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:4 — "repo.workspaceList" reads (repo.workspaceList) and was handed a signal member this parse cannot tie to a read round',
    ]);
  });

  it("reports a record that was handed one", () => {
    // The positive control. A durable act that has reached the daemon has HAPPENED, so
    // a signal on one abandons the console's half of a write mid-flight.
    const sites = plantedSitesInReadHelper([
      'await callDaemon(bridge, "session.join", request, { signal });',
    ]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:3 — records session.join and was handed a signal",
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
      "console/planted/surface.ts:2 — records session.join and was handed options this parse cannot read, so nothing here shows it carries no signal",
      "console/planted/surface.ts:3 — records session.join and was handed options this parse cannot read, so nothing here shows it carries no signal",
    ]);
  });

  it("negative control: a method the registry does not bind is unresolved, never a record", () => {
    // THE ROW A TABLE READER CAN MISS, and what its absence used to buy. `readings`
    // answered `undefined` for a method it holds no row for, `readMethodsOf` found no
    // `true` entry, and the site fell through to the RECORD arm — so an unsignalled
    // read of that method satisfied every one of the readings at once. A computed key
    // or a namespace-qualified schema in the real registry is exactly how one row goes
    // missing, and the classification cannot rest on the reader having caught them all.
    const sites = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.mountRead", request);',
    ]);
    expect(sites.map((site) => classifyDaemonCallSite(site, PLANTED_READINGS))).toStrictEqual([
      "unresolved",
    ]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:3 — "repo.mountRead" names repo.mountRead, which the registry binds no response schema for, so nothing here says whether this call reads',
    ]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: an unresolved call is reported whatever it was handed", () => {
    // THE ARM AN OPTIONS FILTER DROPPED. The unresolved verdict used to be reported
    // through the READ rule, so it was conditional on the options — and a generic
    // binder over the whole registry that happened to pass a signal resolved no
    // method, read `"present"`, and was dropped by all three readings at once. The
    // defect is the unknown method, and no signal argument settles one.
    const signalled = plantedSites([
      "export function bind<MethodName extends ConsoleDaemonMethod>(method: MethodName) {",
      "  return async (request, signal: AbortSignal) =>",
      "    await callDaemon(bridge, method, request, { signal });",
      "}",
    ]);
    expect(signalled.map((site) => site.signalArgument)).toStrictEqual(["present"]);
    expect(unresolvedMethodOffenders(signalled, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:4 — method resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
    const unsignalled = plantedSites([
      "export function bind<MethodName extends ConsoleDaemonMethod>(method: MethodName) {",
      "  return async (request) => await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(unresolvedMethodOffenders(unsignalled, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:3 — method resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
    // And the site is owned by that reading alone, so neither rule double-reports it.
    expect(unstoppableReadOffenders(unsignalled, PLANTED_READINGS)).toStrictEqual([]);
    expect(stoppableRecordOffenders(unsignalled, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("passes the two compliant shapes", () => {
    // The clean side of both lines, so the readings are proved to admit as well as to
    // refuse — a checker answering the empty array to everything reads like a tree in
    // order.
    const sites = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      'await callDaemon(bridge, "session.join", request);',
    ]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(mixedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: a union naming both kinds is reported whatever it was handed", () => {
    // THE ARM THAT PASSED BOTH READINGS. Read as `"read"`, the signal satisfied the
    // read rule while the record reading skipped the site — its verdict was not
    // `"record"` — so a signal that abandons a durable mutation went unreported.
    const sites = plantedSites([
      'async function dispatch(method: "session.join" | "repo.workspaceList", round: ReadRound) {',
      "  return await callDaemon(bridge, method, request, { signal: round.signal });",
      "}",
    ]);
    expect(sites.map((site) => classifyDaemonCallSite(site, PLANTED_READINGS))).toStrictEqual([
      "mixed",
    ]);
    expect(mixedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:3 — method names both a read (repo.workspaceList) and a record (session.join); split the call or narrow the union so one call is one kind",
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
