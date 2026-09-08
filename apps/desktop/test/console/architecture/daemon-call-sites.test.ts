// What a door call SAYS, driven against sources whose verdict is known.
//
// THE GATE IS TWO DOORS DOWN AND THIS IS THE PARSE'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-signal-chokepoint.test.ts` makes the claim
// over the real console, and a clean result there is worth nothing until the reading
// is proved to bite. Every case below writes a source the console does not contain —
// the offending shapes included, which is why they cannot be written in the gate
// itself.
//
// FOUR MODULES ARE DRIVEN TOGETHER because one question is a composition of them:
// `daemon-method-bindings.ts` says which declaration a name at a position means,
// `daemon-method-literals.ts` what that declaration reduces to, `daemon-method-constants.ts`
// what an imported one names in the module it came from, and `daemon-call-sites.ts` reads
// the call through all three — which door it reached and which method it named. A control
// exercising any of them alone would pass over the seams the shadow defects lived in.
//
// TWO BENCHES SIT BESIDE THIS ONE and neither restates its claim. What the call HANDED
// the door is `daemon-signal-argument.test.ts`', and what the registry's partition
// then MAKES of a site is `daemon-read-signal-census.test.ts`'. All three drive one
// planted corpus, so a fixture that drifts drifts for all of them at once.

import { describe, expect, it } from "vitest";

import {
  DOOR_SHADOWED_BY_FUNCTION_DECLARATION,
  emptyIndex,
  NAMESPACE_DOOR_CALLEES,
  PLANTED_READINGS,
  plantedSites,
  plantedSitesDeclaringImports,
  plantedSitesInReadHelper,
  plantedSitesThroughNamespace,
} from "./daemon-call-planting.test-support.js";
import {
  stoppableRecordOffenders,
  unresolvedMethodOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";

describe("the door a call reaches", () => {
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
    const sites = plantedSitesDeclaringImports([
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

  it("negative control: a nearer binding of the door's name is not the door", () => {
    // THE SHADOW A NAME SET CANNOT SEE. The door is imported under `send`, and the
    // callback below takes a parameter of that name — so the call it makes is the
    // parameter's, exactly as the language would run it, and the module's real door
    // call is the one on the line above. Matching the callee text against the module's
    // door spellings counted both, so a helper invoking whatever it was handed was
    // read as a read that carries no signal.
    const sites = plantedSitesDeclaringImports([
      'import { callDaemon as send } from "../../bridge/index.js";',
      "export async function readAdmittedRoots(bridge, request, signal: AbortSignal) {",
      '  await send(bridge, "repo.workspaceList", request, { signal });',
      "  return await withRetry(async (send) => await send(request));",
      "}",
    ]);
    expect(sites.map((site) => site.line)).toStrictEqual([3]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: the exported spelling in a module that imports no door is not one", () => {
    // THE UNCONDITIONAL MATCH, IN BOTH DIRECTIONS. A module that never imported the
    // door was still scanned for the exported spelling, so a local `callDaemon` of its
    // own would have been read as a door call and reported against the registry — and
    // the same reading has to keep finding the real call in a module that spells the
    // word for another reason, which is the half a fail-closed rule could quietly lose.
    expect(
      plantedSitesDeclaringImports([
        "function callDaemon(bridge, method, request) {",
        "  return bridge.send(method, request);",
        "}",
        'export const reply = callDaemon(bridge, "repo.workspaceList", {});',
      ]),
    ).toStrictEqual([]);
    const sites = plantedSitesDeclaringImports([
      'import { callDaemon as send } from "../../bridge/index.js";',
      "function callDaemon(bridge, method, request) {",
      "  return bridge.send(method, request);",
      "}",
      "export async function readAdmittedRoots(bridge, request, signal: AbortSignal) {",
      '  callDaemon(bridge, "repo.workspaceList", request);',
      '  return await send(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    expect(sites.map((site) => site.line)).toStrictEqual([7]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: the door read off a namespace import is still the door", () => {
    // THE SHAPE THAT PASSED EVERY GATE AT ONCE. A callee that is a member read was
    // skipped by a reading admitting only identifiers, and the consumer census beside it
    // skipped the namespace clause too — so such a module contributed no calls AND was
    // counted no consumer, and an unsignalled read in it satisfied every gate at once.
    //
    // BOTH SPELLINGS, from the one declared set: the bracketed key was outside the same
    // two readings for the same reason, so proving one proved nothing about the other.
    for (const door of NAMESPACE_DOOR_CALLEES) {
      const sites = plantedSitesThroughNamespace([
        "export async function readAdmittedRoots(bridge, sessionId) {",
        `  return await ${door}(bridge, "repo.workspaceList", { sessionId });`,
        "}",
      ]);
      expect(
        sites.map((site) => site.resolvedMethods),
        door,
      ).toStrictEqual([["repo.workspaceList"]]);
      expect(unstoppableReadOffenders(sites, PLANTED_READINGS), door).toStrictEqual([
        'console/planted/surface.ts:3 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
      ]);
    }
  });

  it("negative control: a computed key this parse cannot resolve is not the door", () => {
    // The residual the header states, asserted rather than assumed. `daemonDoor[member]`
    // requires deciding what `member` holds, which is a value and not a binding — the
    // depth limit that keeps a door handed in as an argument invisible too, and the line
    // between it and every spelling that still SAYS the member's name in the text.
    expect(
      plantedSitesThroughNamespace([
        "export async function dispatch(bridge, member, request) {",
        '  return await daemonDoor[member](bridge, "repo.workspaceList", request);',
        "}",
      ]),
    ).toStrictEqual([]);
  });

  it("negative control: a hoisted declaration shadows the door over its whole scope", () => {
    // THE SHADOW A SCOPE BUILDER THAT SKIPPED DECLARATIONS COULD NOT SEE. A nested
    // `function callDaemon` is what the two calls in that scope run, above the
    // declaration as well as below it, because the language hoists the name over the
    // scope that holds it. Recording only variables and binding elements let both
    // resolve past it to the import and be reported as unsignalled daemon reads — and
    // the sibling function's real door call is what keeps this control non-vacuous.
    const shadowed = plantedSites(DOOR_SHADOWED_BY_FUNCTION_DECLARATION);
    expect(shadowed.map((site) => site.line)).toStrictEqual([10]);
    expect(unstoppableReadOffenders(shadowed, PLANTED_READINGS)).toStrictEqual([]);
    // The same rule one keyword away: a class declaration binds its name the same way.
    const shadowedByClass = plantedSites([
      "export function makeDoor(bridge, request) {",
      "  class callDaemon {}",
      '  return callDaemon(bridge, "repo.workspaceList", request);',
      "}",
      "export async function readAdmittedRoots(bridge, request, signal: AbortSignal) {",
      '  return await callDaemon(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    expect(shadowedByClass.map((site) => site.line)).toStrictEqual([7]);
    expect(unstoppableReadOffenders(shadowedByClass, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: a function or class EXPRESSION names only its own body", () => {
    // THE OTHER DIRECTION OF THE SAME RULE, and the error a hoisting fix invites: an
    // expression's own name binds INSIDE it and nowhere else, so recording either of
    // these in the enclosing scope would invent a shadow the language does not have and
    // the door call below them would stop being one.
    const sites = plantedSitesInReadHelper([
      "const helper = function callDaemon(door, method, payload) {",
      '  return callDaemon(door, "repo.workspaceList", payload);',
      "};",
      "const holder = class callDaemon {",
      "  static send(door, payload) {",
      '    return callDaemon(door, "repo.workspaceList", payload);',
      "  }",
      "};",
      'await callDaemon(bridge, "repo.workspaceList", request, { signal });',
    ]);
    expect(sites.map((site) => site.line)).toStrictEqual([11]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: the name a module gave the namespace is not what makes it the door", () => {
    // A namespace has no canonical spelling, so a needle keyed on the one the shared
    // corpus happens to plant would report that fixture and miss every real module. The
    // binding is resolved; the name it was given says nothing.
    const sites = plantedSitesDeclaringImports([
      'import * as wire from "../../bridge/index.js";',
      "export async function readAdmittedRoots(bridge, request, signal: AbortSignal) {",
      '  return await wire.callDaemon(bridge, "repo.workspaceList", request, { signal });',
      "}",
    ]);
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([["repo.workspaceList"]]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: a nearer binding of the namespace's name is not the door", () => {
    // THE SHADOW, ON THE OTHER ARM. `daemonDoor` is the bridge family at module scope
    // and a local object inside the function, so the call the function makes is the
    // local's, exactly as the language would run it — and the module's real door call
    // is the one outside it. A rule that matched the spelling would report both.
    const sites = plantedSitesThroughNamespace([
      'await daemonDoor.callDaemon(bridge, "session.join", request);',
      "export function withStub(bridge, request) {",
      "  const daemonDoor = { callDaemon: stubbedCall };",
      '  return daemonDoor.callDaemon(bridge, "repo.workspaceList", request);',
      "}",
    ]);
    expect(sites.map((site) => site.line)).toStrictEqual([2]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: a member read that is not the door, off a name that is not one", () => {
    // The other direction of the same claim, in the three shapes that share the
    // property-access spelling and none of which is a door call: another member of the
    // door's own namespace, a namespace of a module that is not the door reached for
    // something else, and the door's own name read off a bridge handed in as an
    // argument — which is a value this scan cannot follow and deliberately does not
    // guess at, on the depth limit the header states.
    expect(
      plantedSitesThroughNamespace([
        'await daemonDoor.formatRefusal(bridge, "repo.workspaceList", request);',
      ]),
    ).toStrictEqual([]);
    expect(
      plantedSitesDeclaringImports([
        'import * as formatting from "../../console/formatting.js";',
        'await formatting.render("repo.workspaceList");',
      ]),
    ).toStrictEqual([]);
    expect(
      plantedSitesDeclaringImports([
        "export async function readAdmittedRoots(door, request) {",
        '  return await door.callDaemon(door, "repo.workspaceList", request);',
        "}",
      ]),
    ).toStrictEqual([]);
  });
});

describe("the method a call names", () => {
  it("reads the method and the signal off a literal call", () => {
    const [site] = plantedSitesInReadHelper([
      'const reply = await callDaemon(bridge, "repo.workspaceList", request, { signal });',
    ]);
    expect(site?.resolvedMethods).toStrictEqual(["repo.workspaceList"]);
    expect(site?.signalArgument).toBe("present");
    expect(site?.line).toBe(3);
  });

  it("resolves a method constant another module declares, reached by import", () => {
    // Two of the console's call sites name a constant `agents/agent-wire.ts` declares.
    // The import is the binding this module has; the index is asked for the name that
    // import came from and the module that import names.
    const constants = emptyIndex();
    constants.add('export const LIST_METHOD = "repo.workspaceList";', "console/planted/wire.ts");
    const [site] = plantedSitesDeclaringImports(
      [
        'import { callDaemon } from "../../bridge/index.js";',
        'import { LIST_METHOD } from "./wire.js";',
        "await callDaemon(bridge, LIST_METHOD, request);",
      ],
      constants,
    );
    expect(site?.resolvedMethods).toStrictEqual(["repo.workspaceList"]);
  });

  it("negative control: two modules binding one spelling resolve to the imported one", () => {
    // THE COLLISION A BARE-NAME INDEX CANNOT SEE. Keyed by the spelling alone, both
    // modules' `METHOD` folded into one entry, the fold called the name ambiguous, and
    // this call — which names exactly one of them — resolved to NOTHING and was
    // reported as naming no registered method at all. The import says which module,
    // and (module, exported name) admits one declaration by construction.
    const constants = emptyIndex();
    constants.add('export const METHOD = "repo.workspaceList";', "console/planted/reads.ts");
    constants.add('export const METHOD = "session.join";', "console/planted/records.ts");
    const sites = plantedSitesDeclaringImports(
      [
        'import { callDaemon } from "../../bridge/index.js";',
        'import { METHOD } from "./reads.js";',
        "export async function readWorkspaces(bridge, request, signal: AbortSignal) {",
        "  return await callDaemon(bridge, METHOD, request, { signal });",
        "}",
      ],
      constants,
    );
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([["repo.workspaceList"]]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
  });

  it("negative control: an unexported constant is not reachable by any import", () => {
    // THE OTHER HALF, AND THE ONE THAT REPORTED A METHOD THE CALL NEVER NAMED. The
    // module the import names exports a value this parse cannot reduce, so it is
    // skipped — and an unrelated module's PRIVATE `METHOD` was the one entry the fold
    // held under that spelling. The call resolved to it, classified as a record, and
    // was reported for carrying the signal its own read needs.
    const constants = emptyIndex();
    constants.add("export const METHOD = composeMethod();", "console/planted/reads.ts");
    constants.add('const METHOD = "session.join";', "console/planted/records.ts");
    const sites = plantedSitesDeclaringImports(
      [
        'import { callDaemon } from "../../bridge/index.js";',
        'import { METHOD } from "./reads.js";',
        "export async function readWorkspaces(bridge, request, signal: AbortSignal) {",
        "  return await callDaemon(bridge, METHOD, request, { signal });",
        "}",
      ],
      constants,
    );
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([[]]);
    expect(stoppableRecordOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:4 — METHOD resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
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
      "console/planted/surface.ts:5 — method reads (repo.workspaceList) and was handed no signal",
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
