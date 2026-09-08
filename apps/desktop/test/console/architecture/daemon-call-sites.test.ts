// What a door call SAYS, driven against sources whose verdict is known.
//
// THE GATE IS TWO DOORS DOWN AND THIS IS THE PARSE'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-signal-chokepoint.test.ts` makes the claim
// over the real console, and a clean result there is worth nothing until the reading
// is proved to bite. Every case below writes a source the console does not contain —
// the offending shapes included, which is why they cannot be written in the gate
// itself.
//
// TWO MODULES ARE DRIVEN TOGETHER because one question is a composition of them:
// `daemon-method-bindings.ts` says what a name is bound to and `daemon-call-sites.ts`
// reads the call through it. A control that exercised either in isolation would pass
// over exactly the seams where the shadow and the wrong-signal defects lived. What
// the verdicts and the offender readings then MAKE of a site is the neighbouring
// bench's subject, `daemon-read-signal-census.test.ts`; the two share one planted
// corpus and neither restates the other's claim.

import { describe, expect, it } from "vitest";

import {
  emptyIndex,
  PLANTED_READINGS,
  plantedSites,
  plantedSitesInReadHelper,
} from "./daemon-call-planting.test-support.js";
import { unstoppableReadOffenders } from "./daemon-read-signal-census.js";

describe("the method a call names", () => {
  it("reads the method and the signal off a literal call", () => {
    const [site] = plantedSitesInReadHelper([
      'const reply = await callDaemon(bridge, "repo.workspaceList", request, { signal });',
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["repo.workspaceList"]);
    expect(site?.signalArgument).toBe("present");
    expect(site?.line).toBe(2);
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
  });
});

describe("the signal a call hands the door", () => {
  it("reports an options argument it cannot read as its own answer", () => {
    // A spread and a held variable each hide the member from this parse. Answering
    // `absent` for them was fail-closed for a read and fail-OPEN for a record, whose
    // rule is that no signal was passed — so the reading is not a boolean.
    const [spread] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { ...options });',
    ]);
    expect(spread?.signalArgument).toBe("opaque");
    const [held] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, options);',
    ]);
    expect(held?.signalArgument).toBe("opaque");
    const [read] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "session.join", request, { cause });',
    ]);
    expect(read?.signalArgument).toBe("absent");
  });

  it("takes a forwarded parameter, annotated or contextually typed", () => {
    // The two spellings the console's own reads carry: the `repos` and inventory
    // helpers annotate `signal: AbortSignal`, and the arrow a push-driven read hands
    // its round's signal to declares nothing, because the seat's option type declares
    // it. Both are signals this call was HANDED, which is the property that matters.
    const [annotated] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal });',
    ]);
    expect(annotated?.signalArgument).toBe("present");
    const [contextual] = plantedSites([
      "export function createRoster(bridge) {",
      "  return new PushDrivenRead({",
      "    read: async (signal) =>",
      '      await callDaemon(bridge, "repo.workspaceList", {}, { signal }),',
      "  });",
      "}",
    ]);
    expect(contextual?.signalArgument).toBe("present");
  });

  it("takes a round's signal, off the parameter and off the local it was opened into", () => {
    // The other two shapes `store/read-cancellation.ts` produces. A performer is
    // handed the round; a reader that owns the line opens one on its own scope.
    const [handed] = plantedSites([
      "class QuotaReadout {",
      "  async #read(round: ReadRound) {",
      '    return await callDaemon(this.#bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "  }",
      "}",
    ]);
    expect(handed?.signalArgument).toBe("present");
    const [opened] = plantedSites([
      "export function readBoundary(bridge, readScope) {",
      "  const round = readScope.openRound();",
      '  return callDaemon(bridge, "repo.workspaceList", {}, { signal: round.signal });',
      "}",
    ]);
    expect(opened?.signalArgument).toBe("present");
  });

  it("negative control: a signal this call minted itself is not the round's", () => {
    // THE HOLE A KEY CHECK LEAVES, in the four spellings that fit through it. Each
    // line hands the door a member NAMED `signal` and none of them is a signal the
    // read line can abort: an already-aborted one stops nothing that ever ran, and a
    // controller minted beside the call is superseded by nothing and abandoned by
    // nobody. All four answered `"present"` while the property name was the test.
    const readings = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: AbortSignal.abort() });',
      "const controller = new AbortController();",
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: controller.signal });',
      'await callDaemon(bridge, "repo.workspaceList", request, {',
      "  signal: new AbortController().signal,",
      "});",
      "const staleSignal = controller.signal;",
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: staleSignal });',
    ]).map((site) => site.signalArgument);
    expect(readings).toStrictEqual([
      "unrecognised",
      "unrecognised",
      "unrecognised",
      "unrecognised",
    ]);
  });

  it("negative control: a member named signal off a name nothing binds is refused", () => {
    // The other half of the same claim, and the fail-closed direction: an ambient or a
    // global this scan cannot see is not admitted on the strength of its spelling, and
    // neither is a `signal` member that carries no value expression at all.
    const [ambient] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: ambientRound.signal });',
    ]);
    expect(ambient?.signalArgument).toBe("unrecognised");
    const [accessor] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, {',
      "  signal() {",
      "    return undefined;",
      "  },",
      "});",
    ]);
    expect(accessor?.signalArgument).toBe("unrecognised");
  });

  it("negative control: a round is not a signal, and a signal is not a round", () => {
    // The two forms are read at their own positions rather than pooled. A `ReadRound`
    // handed on bare where a signal goes is not an `AbortSignal`, and a forwarded
    // signal has no `signal` member to read off it.
    const [bareRound] = plantedSites([
      "async function performRead(bridge, request, round: ReadRound) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal: round });',
      "}",
    ]);
    expect(bareRound?.signalArgument).toBe("unrecognised");
    const [nestedSignal] = plantedSitesInReadHelper([
      'await callDaemon(bridge, "repo.workspaceList", request, { signal: signal.signal });',
    ]);
    expect(nestedSignal?.signalArgument).toBe("unrecognised");
  });
});
