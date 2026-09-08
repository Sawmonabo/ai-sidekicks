// What METHOD a door call names, driven against sources whose verdict is known.
//
// THE SIBLING OF `daemon-call-sites.test.ts`, split from it on the seam
// `daemon-call-sites.ts` already draws: that bench drives which DOOR a callee resolves
// to, and this one drives what the name it passes as its method is BOUND to. One file
// held both until the transparent-wrapper and mutable-binding controls landed, at which
// point it was two benches sharing a header.
//
// THREE MODULES ARE DRIVEN TOGETHER because one question is a composition of them:
// `daemon-method-bindings.ts` says which declaration a name at a position means,
// `daemon-method-literals.ts` what that declaration reduces to and whether anything can
// write it again, and `daemon-method-constants.ts` what an imported one names in the
// module it came from. A control exercising any of them alone would pass over the seams
// the shadow defects lived in.
//
// AND THE VERDICT IS READ THROUGH THE CENSUS, not asserted as a set of names: a method
// this parse cannot reduce is reported on its own offender reading, which is what makes
// "unresolved" a claim about the gate rather than about this file's expectations.

import { describe, expect, it } from "vitest";

import {
  emptyIndex,
  PLANTED_READINGS,
  plantedSites,
  plantedSitesDeclaringImports,
  plantedSitesInReadHelper,
} from "./daemon-call-planting.test-support.js";
import {
  stoppableRecordOffenders,
  unresolvedMethodOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";

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

  it("negative control: an exported binding the other module can write resolves to nothing", () => {
    // THE SAME HOLE ACROSS A MODULE BOUNDARY. An `export let METHOD` is whatever the
    // exporting module last wrote to it, and an index that recorded its initializer would
    // hand this importer a method the program may already have replaced — classifying a
    // read as a record from one module over, which is the direction that exempts a call
    // from the signal rule it needs.
    const constants = emptyIndex();
    constants.add('export let METHOD = "repo.workspaceList";', "console/planted/reads.ts");
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
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:4 — METHOD resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
  });

  it("negative control: a binding the module can write again resolves to nothing", () => {
    // THE VALUE A DECLARATION DOES NOT PIN. A reader that reduced every variable to its
    // initializer read the `let` below as the record it was declared with, so the read
    // this call really makes was classified from a value the line above it has already
    // replaced — and a record is exempt from the rule that a read shows what stops it.
    //
    // ONLY A `const` REDUCES, and the rule is about the binding FORM rather than about
    // whether a write happens to be in the file: the `var` below is never written and is
    // unresolved all the same, because what makes the initializer evidence is that
    // nothing can replace it. Following the writes instead would be the dataflow engine
    // `daemon-method-literals.ts` states, in its own header, that this parse is not.
    const rewritten = plantedSites([
      "export async function dispatch(bridge, request) {",
      '  let method: ConsoleDaemonMethod = "session.join";',
      '  method = "repo.workspaceList";',
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(rewritten.map((site) => site.resolvedMethods)).toStrictEqual([[]]);
    expect(unresolvedMethodOffenders(rewritten, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:5 — method resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
    expect(
      plantedSites([
        "export async function dispatch(bridge, request) {",
        '  var method = "session.join";',
        "  return await callDaemon(bridge, method, request);",
        "}",
      ]).map((site) => site.resolvedMethods),
    ).toStrictEqual([[]]);
    // The positive control the rule owes: the same call one keyword away still reduces,
    // so what moved is the writable binding rather than the reading of an initializer.
    const held = plantedSites([
      "export async function dispatch(bridge, request) {",
      '  const method = "session.join";',
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(held.map((site) => site.resolvedMethods)).toStrictEqual([["session.join"]]);
    expect(stoppableRecordOffenders(held, PLANTED_READINGS)).toStrictEqual([]);
    expect(unresolvedMethodOffenders(held, PLANTED_READINGS)).toStrictEqual([]);
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

  it("negative control: a `var` in an inner block binds for the whole function", () => {
    // THE SHADOW A BLOCK DOES NOT MAKE. `var` is function-scoped, so the declaration
    // below binds `method` from the top of `dispatch` and the call after the block reads
    // it — while a walk that recorded every variable in the block it was written in left
    // the binding inside the braces, looked past it, and answered with the MODULE
    // constant. That is the shadow direction that exempts: the outer name is a record,
    // and a record is asked for no signal.
    //
    // AND WHAT THE FIX ANSWERS IS NOTHING, WHICH IS THE POINT. A `var` is writable, so
    // `daemon-method-literals.ts` reduces it to no literal however it was initialized —
    // the call is reported as naming a method this parse cannot read, which is the
    // fail-closed reading. Resolving to the outer record was the answer that hid it.
    const sites = plantedSites([
      'const method = "session.join";',
      "export async function dispatch(bridge, request) {",
      "  {",
      '    var method: "repo.workspaceList" = "repo.workspaceList";',
      "  }",
      "  return await callDaemon(bridge, method, request);",
      "}",
      "export async function dispatchElsewhere(bridge, request) {",
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    // The second call is the half that says the hoist reaches the FUNCTION and stops
    // there: a walk that lifted every `var` to the module scope would answer this one
    // from a binding written inside a function it is not in.
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([[], ["session.join"]]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:7 — method resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
  });

  it("negative control: a caught binding shadows the constant it is spelled like", () => {
    // THE BINDING NO DECLARATION LIST CARRIES. A `catch` clause names its own variable,
    // and the name is a bare `VariableDeclaration` with no list over it — so a walk that
    // reached bindings only through a list, a binding element or a declared function
    // opened the catch's scope and then declared nothing into it, and the call inside
    // resolved to the module constant one scope out. The caught value is whatever was
    // thrown, and reading it as `session.join` classified this line as a record.
    const sites = plantedSites([
      'const method = "session.join";',
      "export async function dispatch(bridge, request) {",
      "  try {",
      "    await mightThrow();",
      "  } catch (method) {",
      '    if (method === "repo.workspaceList") {',
      "      return await callDaemon(bridge, method, request);",
      "    }",
      "  }",
      "}",
    ]);
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([[]]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([
      "console/planted/surface.ts:8 — method resolves to no registered method, so this call could name a read and nothing here says what stops it",
    ]);
  });

  it("negative control: a class static block is a variable scope of its own", () => {
    // WHERE HOISTING STOPS. A static initialization block runs once with a variable
    // environment of its own, so the `var` below is the block's and reaches nothing after
    // the class — and a walk that knew only which scopes a BLOCK opens carried it out to
    // the nearest function or module, where it overwrote the door's own import. Both of
    // this module's calls then stopped being door calls at all: the one inside the block
    // names a local that is not the door, and the one after the class resolved the door's
    // own name to that same local. A gate reporting no site is a gate reporting that this
    // module makes no daemon call.
    //
    // THE `const` BESIDE IT IS THE HALF THAT ALREADY HELD, and it is planted anyway: the
    // block's own body is a `Block`, so a lexical declaration inside one has always landed
    // in a scope of its own. What the static block adds is the variable scope, and the two
    // are asserted together so a later walk cannot trade one for the other.
    const sites = plantedSites([
      'const method = "session.join";',
      "class Wiring {",
      "  static {",
      "    var callDaemon = (door, name, payload) => door.send(name, payload);",
      '    const method = "repo.workspaceList";',
      "    callDaemon(bridge, method, request);",
      "  }",
      "}",
      "export async function dispatch(bridge, request) {",
      "  return await callDaemon(bridge, method, request);",
      "}",
    ]);
    expect(sites.map((site) => site.line)).toStrictEqual([11]);
    expect(sites.map((site) => site.resolvedMethods)).toStrictEqual([["session.join"]]);
    expect(unresolvedMethodOffenders(sites, PLANTED_READINGS)).toStrictEqual([]);
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
