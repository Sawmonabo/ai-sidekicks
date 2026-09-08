// Which DOOR a call reaches, driven against sources whose verdict is known.
//
// THE GATE IS TWO DOORS DOWN AND THIS IS THE PARSE'S OWN BENCH, on the
// `barrel-census.test.ts` pattern: `read-signal-chokepoint.test.ts` makes the claim
// over the real console, and a clean result there is worth nothing until the reading
// is proved to bite. Every case below writes a source the console does not contain —
// the offending shapes included, which is why they cannot be written in the gate
// itself.
//
// ONE SUBJECT, AND ITS SIBLING IS `daemon-method-resolution.test.ts`'. A door call is
// two readings of one node — which binding the callee resolves to, and which method the
// argument names — and they are two benches because they are two questions: this one
// drives `namesCallDoor` against the scope chain, and the other drives what a name a
// call PASSES is bound to. They lived in one file until the wrapper and mutable-binding
// controls landed and it was holding both.
//
// TWO MORE BENCHES SIT BESIDE THEM and neither restates this claim. What the call
// HANDED the door is `daemon-signal-argument.test.ts`', and what the registry's
// partition then MAKES of a site is `daemon-read-signal-census.test.ts`'. All four
// drive one planted corpus, so a fixture that drifts drifts for all of them at once.

import { describe, expect, it } from "vitest";

import {
  DOOR_SHADOWED_BY_FUNCTION_DECLARATION,
  NAMESPACE_DOOR_CALLEES,
  PLANTED_READINGS,
  plantedSites,
  plantedSitesDeclaringImports,
  plantedSitesInReadHelper,
  plantedSitesThroughNamespace,
  TRANSPARENTLY_WRAPPED_DOOR_CALLEES,
  WRAPPED_NAMESPACE_DOOR_CALLEES,
} from "./daemon-call-planting.test-support.js";
import { unstoppableReadOffenders } from "./daemon-read-signal-census.js";

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
      'import { callDaemon as send } from "../bridge/index.js";',
      "export async function readAdmittedRoots(bridge, sessionId) {",
      '  return await send(bridge, "repo.workspaceList", { sessionId });',
      "}",
    ]);
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([["repo.workspaceList"]]);
    expect(unstoppableReadOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      'console/planted/surface.ts:3 — "repo.workspaceList" reads (repo.workspaceList) and was handed no signal',
    ]);
  });

  it("negative control: the door's name imported from another module is not the door", () => {
    // THE MODULE HALF OF THE (MODULE, NAME) PAIR AN EXPORT IS. The callee resolved to
    // an import specifier and the specifier's own MODULE was never asked, so a module
    // publishing its own `callDaemon` from anywhere in the tree contributed call sites
    // to this scan — sites naming a method the bridge never carried, reported against a
    // door the module does not hold. The clause is the whole of the difference: the
    // aliased case above writes the bridge's own module and is a call, and this one
    // writes another and is none.
    expect(
      plantedSitesDeclaringImports([
        'import { callDaemon } from "./not-the-door.js";',
        "export async function readAdmittedRoots(bridge, sessionId) {",
        '  return await callDaemon(bridge, "repo.workspaceList", { sessionId });',
        "}",
      ]),
    ).toStrictEqual([]);
  });

  it("negative control: a nearer binding of the door's name is not the door", () => {
    // THE SHADOW A NAME SET CANNOT SEE. The door is imported under `send`, and the
    // callback below takes a parameter of that name — so the call it makes is the
    // parameter's, exactly as the language would run it, and the module's real door
    // call is the one on the line above. Matching the callee text against the module's
    // door spellings counted both, so a helper invoking whatever it was handed was
    // read as a read that carries no signal.
    const sites = plantedSitesDeclaringImports([
      'import { callDaemon as send } from "../bridge/index.js";',
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
      'import { callDaemon as send } from "../bridge/index.js";',
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

  it("negative control: a transparent wrapper around the door is still the door", () => {
    // THE DOOR A READER STOPPED ONE NODE ABOVE. `(callDaemon as typeof callDaemon)(…)` is
    // the same call the emitter writes without the cast, and a scan resolving the WRAPPER
    // as its callee found no door in it — so the module stayed a counted consumer through
    // its named import while this call contributed no site at all and passed every signal
    // check by not existing. Driven over the closed list of five rather than the one
    // spelling that was noticed, because each wrapper is a different node kind.
    for (const door of TRANSPARENTLY_WRAPPED_DOOR_CALLEES) {
      const sites = plantedSites([
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
    // And the same wrappers one node deeper, around the NAMESPACE the door is read off:
    // a member read resolves its object exactly as a bare callee resolves itself, so a
    // wrapper there is the identical hole against the identical binding.
    for (const door of WRAPPED_NAMESPACE_DOOR_CALLEES) {
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

  it("negative control: a wrapper does not make a name that is not the door into one", () => {
    // The other direction, so the peeling is a reading of the callee rather than a
    // widening of what counts as one: the wrappers are transparent to the BINDING too,
    // and a local of the door's own name under a cast is still the local.
    expect(
      plantedSitesDeclaringImports([
        "function callDaemon(bridge, method, request) {",
        "  return bridge.send(method, request);",
        "}",
        'export const reply = (callDaemon as typeof callDaemon)(bridge, "repo.workspaceList", {});',
      ]),
    ).toStrictEqual([]);
    expect(
      plantedSitesThroughNamespace([
        'await (daemonDoor as typeof daemonDoor).formatRefusal(bridge, "repo.workspaceList", {});',
      ]),
    ).toStrictEqual([]);
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
      'import * as wire from "../bridge/index.js";',
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
