// The read-versus-record partition and its four offender readings, driven against
// sources whose verdict is known.
//
// THE PARTITION IS NOT THIS BENCH'S EITHER. The console declares it in
// `bridge/daemon/daemon-method-classification.ts`, total over the registry's own key
// set; what the cases below drive is how a planted TABLE's rows are folded through it,
// and what each of the four readings then makes of a call. The kind of a real method is
// that module's claim and `read-signal-chokepoint.test.ts`' floors, not a fixture's.
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
// site and asks what the console's partition makes of it, and what each of the four
// readings then owes. The two share one planted corpus so neither drifts from the
// other, and each site is owned by exactly one reading — which is itself a claim the
// cases below make rather than assume.

import { describe, expect, it } from "vitest";

import {
  DOOR_SHADOWED_BY_FUNCTION_DECLARATION,
  NAMESPACE_DOOR_CALLEES,
  PLANTED_READINGS,
  PLANTED_REGISTRY,
  plantedSites,
  plantedSitesInReadHelper,
  plantedSitesThroughNamespace,
  plantedSitesThroughNamespaceInReadHelper,
} from "./daemon-call-planting.test-support.js";
import {
  classifyDaemonCallSite,
  daemonMethodReadings,
  mixedMethodOffenders,
  stoppableRecordOffenders,
  unresolvedMethodOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";

/** One planted binding row, in the shape the registry's own table writes. */
function plantedRow(method: string, responseSchema: string): string {
  return `  ${JSON.stringify(method)}: bindDaemonMethod(RequestSchema, ${responseSchema}),`;
}

/** A planted binding table over the rows a case names. */
function plantedTable(...rows: readonly string[]): string {
  return ["export const CONSOLE_DAEMON_METHOD_BINDINGS = Object.freeze({", ...rows, "});"].join(
    "\n",
  );
}

describe("the console's declared partition, applied to the table's rows", () => {
  it("takes the kind from the classification and the keys from the table", () => {
    // TWO SOURCES, EACH ANSWERING ITS OWN HALF. The rows say which methods the registry
    // binds; `bridge/daemon/daemon-method-classification.ts` says what each of them is.
    // Nothing here decides a kind from how a method or its schema is spelled.
    expect(PLANTED_READINGS.get("repo.workspaceList")).toBe(true);
    expect(PLANTED_READINGS.get("session.join")).toBe(false);
    expect(daemonMethodReadings(PLANTED_REGISTRY).size).toBe(2);
  });

  it("negative control: a write whose reply schema is named like a reading still records", () => {
    // THE FIRST HALF OF THE HAZARD THE WORD RULE CARRIED. `Read`, `List`, and `Check`
    // were the whole classifier, so a durable write whose reply schema happened to
    // carry one of them classified as a read — and was then required to carry an abort
    // signal that would abandon it mid-flight. The schema name is not read at all now,
    // so all three spellings answer what the console says the method is.
    const readings = daemonMethodReadings(
      plantedTable(
        plantedRow("providerAccount.probe", "ProviderAccountProbeReadResponseSchema"),
        plantedRow("repo.attach", "RepoAttachListResponseSchema"),
        plantedRow("session.create", "SessionCreateCheckResponseSchema"),
      ),
    );
    expect([...readings.values()]).toStrictEqual([false, false, false]);
  });

  it("negative control: a read whose reply schema carries no known verb still reads", () => {
    // The other half. A reading named with a fourth verb classified as a record and was
    // excused from carrying the signal that stops it, which is the direction that made
    // the rule quietly weaker rather than noisily wrong.
    const readings = daemonMethodReadings(
      plantedTable(
        plantedRow("repo.workspaceList", "WorkspaceProbeResponseSchema"),
        plantedRow("presence.read", "PresenceAckSchema"),
      ),
    );
    expect([...readings.values()]).toStrictEqual([true, true]);
  });

  it("negative control: an import clause that renames a schema changes nothing", () => {
    // THE RENAME THAT USED TO DELETE THE VERB. `WorkspaceListResponseSchema as
    // WorkspaceResponseSchema` left the whole classification outside the identifier the
    // row carried, so a read was exempted from the signal rule by a rename in a file
    // the rule is not about. The clause is now beside the point, which is a stronger
    // property than resolving it correctly was.
    const aliased = daemonMethodReadings(
      [
        "import {",
        "  SessionJoinResponseSchema,",
        "  WorkspaceListResponseSchema as WorkspaceResponseSchema,",
        '} from "@ai-sidekicks/contracts";',
        plantedTable(
          plantedRow("repo.workspaceList", "WorkspaceResponseSchema"),
          plantedRow("session.join", "SessionJoinResponseSchema"),
        ),
      ].join("\n"),
    );
    expect(aliased.get("repo.workspaceList")).toBe(true);
    expect(aliased.get("session.join")).toBe(false);
  });

  it("negative control: a bound method the console does not register is left out", () => {
    // FAIL-CLOSED AT THE OTHER EDGE. The classification is total over the contract's
    // keys and says nothing about a name outside them, so a row for such a name is
    // absent from the partition rather than defaulted onto one of its sides — and every
    // call naming it is reported by the unresolved reading, which no options argument
    // satisfies.
    const readings = daemonMethodReadings(
      plantedTable(
        plantedRow("session.rename", "SessionRenameResponseSchema"),
        plantedRow("session.join", "SessionJoinResponseSchema"),
      ),
    );
    expect([...readings.keys()]).toStrictEqual(["session.join"]);
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

  it("reports an unsignalled read behind a namespace import, and admits a signalled one", () => {
    // THE SPELLING THAT WAS EXEMPT FROM ALL FOUR READINGS. A door reached as
    // `daemonDoor.callDaemon(…)` produced no site, so this census classified nothing and
    // reported nothing — a module could hold the same forgotten signal the browser pane
    // held and be green here, in the reach scan, and in the pinned consumer count at
    // once. Both directions are asserted, because a reading that only refuses reads like
    // a rule nobody can satisfy and would be turned off within a week.
    //
    // IN BOTH SPELLINGS OF THAT READ, from the corpus's own declared set: the bracketed
    // key was outside this census for exactly the reason the dotted one had been, so a
    // case written for one of them proves nothing about the other.
    for (const door of NAMESPACE_DOOR_CALLEES) {
      const unsignalled = plantedSitesThroughNamespace([
        "export function useAdmittedRoots(bridge, sessionId) {",
        `  const reply = await ${door}(bridge, "repo.workspaceList", { sessionId });`,
        "}",
      ]);
      expect(unstoppableReadOffenders(unsignalled, PLANTED_READINGS), door).toStrictEqual([
        'console/planted/surface.ts:3 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
      ]);
      const signalled = plantedSitesThroughNamespaceInReadHelper([
        `await ${door}(bridge, "repo.workspaceList", request, { signal });`,
        `await ${door}(bridge, "session.join", request);`,
      ]);
      expect(
        signalled.map((site) => site.signalArgument),
        door,
      ).toStrictEqual(["present", "absent"]);
      expect(unstoppableReadOffenders(signalled, PLANTED_READINGS), door).toStrictEqual([]);
      expect(stoppableRecordOffenders(signalled, PLANTED_READINGS), door).toStrictEqual([]);
    }
  });

  it("negative control: a local function of the door's name is reported by no reading", () => {
    // THE OFFENDER AN UNRECORDED DECLARATION MANUFACTURED. Both calls inside the helper
    // are the nested `function callDaemon`'s, so neither is a daemon read at all — and a
    // scope builder that skipped function declarations resolved both past it to the
    // import and reported two reads that carry no signal, against a module whose only
    // real door call carries one. A gate reporting a defect the program does not have is
    // turned off as fast as one that misses the defect it does.
    const sites = plantedSites(DOOR_SHADOWED_BY_FUNCTION_DECLARATION);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
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
    // or a spread in the real registry is exactly how one row goes missing, and the
    // classification cannot rest on the reader having caught them all.
    const sites = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.mountRead", request);',
    ]);
    expect(sites.map((site) => classifyDaemonCallSite(site, PLANTED_READINGS))).toStrictEqual([
      "unresolved",
    ]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:3 — "repo.mountRead" names repo.mountRead, which the classified method table does not carry, so nothing here says whether this call reads',
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
