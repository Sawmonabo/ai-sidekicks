// Every call the console makes through the daemon door, read off the syntax tree.
//
// A MODEL BESIDE ITS GATE, on the `daemon-call-census.ts` pattern next door. That
// module answers WHICH modules reach the door; this one answers what each individual
// call at that door said — the method it named, and what it handed the door in place
// of a signal. They are two questions with two subjects (a module, a call) and the
// second one is the one a read-cancellation claim is about: `read-signal-chokepoint`
// held run-control dispatchers to naming no abort and had no complementary reading,
// so a read that simply forgot its signal was indistinguishable from a mutation that
// deliberately passes none. `DaemonCallOptions.signal` is optional by design, and
// absence being legal is exactly how two reads shipped without one.
//
// THE INSTRUMENT IS THE PARSER, for `daemon-call-census.ts`' reasons and one more of
// its own. A text needle for `{ signal }` matches the word in the prose of every
// module that explains why it passes one, and a needle for the method matches the
// registry's own table listing all thirty. Neither survives contact with this tree.
//
// AND THE DOOR IS THE BINDING THE CALL SEES, not a name in a set. Matching the callee
// against this module's door spellings answered two questions wrongly at once. A
// nested `send` — a parameter, a local, a callback argument — SHADOWS an import of the
// door aliased to that spelling, and the language says the shadow wins while the name
// set said the door did; and the exported spelling `callDaemon` was matched
// unconditionally, in modules that never imported it, so any function of that name
// would have been read as the door. Both are the same defect the method resolution
// already refuses, so both are refused the same way: the callee is resolved through
// `daemon-method-bindings.ts` at the call's own position, and it is a door call only
// where that resolution lands on an import specifier the door was imported through.
// A module holding no such import contributes no calls, which is what it means for a
// module not to reach the door.
//
// AND THE METHOD IS RESOLVED RATHER THAN REQUIRED TO BE A LITERAL — through the same
// LEXICAL binding. Ten of the console's call sites name a module constant, one names a
// parameter typed as a union of two literals, and one names a generic type parameter,
// so a scan that read only string literals would report two thirds of the console
// unclassifiable and be ignored. What resolves them is the scope chain and not a name
// index: the first enclosing scope that binds the identifier is the answer, so an
// inner binding shadows an outer one exactly as the language says it does — and an
// import is asked of `daemon-method-constants.ts` under the module it names as well as
// the name it came from, because a bare name identifies no export.
//
// WHAT IS DELIBERATELY UNRESOLVED, and why that is the fail-closed direction. A method
// this parse cannot reduce to a set of names is reported with an empty set, and the
// gate gives such a site a reading of its own that no options argument can satisfy —
// because a call that could name a read is a defect whatever it was handed, and
// whether or not today's callers happen to pass a mutation. The alternative reading,
// exempting what it cannot classify, is the hole this whole file exists to close.
//
// WHAT THE CALL HANDED THE DOOR is `daemon-signal-argument.ts`' subject, for the same
// reason the method's binding is `daemon-method-bindings.ts`': the reading is about a
// value's provenance rather than about which calls exist, and the four verdicts it
// answers with are what both of the census's rules are written against.
//
// THE HONEST LIMIT. What stays invisible is a door reached through a value handed in
// from somewhere else — a bound method, a door stored on an object — which is the same
// depth limit the reach census states, and the reason the lint ban beside it remains a
// second claim rather than a closure of this one.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { CALL_DOOR_EXPORT } from "./daemon-call-census.js";
import { ModuleBindingScopes, withoutTypeWrappers } from "./daemon-method-bindings.js";
import { DaemonMethodConstantIndex } from "./daemon-method-constants.js";
import { readSignalArgument, type SignalArgumentReading } from "./daemon-signal-argument.js";

/** Where the method name sits in the door's argument list. */
const METHOD_ARGUMENT_INDEX = 1;

/** Where `DaemonCallOptions` sits in it. */
const OPTIONS_ARGUMENT_INDEX = 3;

/** One call at the daemon door, as its own source text describes it. */
export interface DaemonCallSite {
  /** What a failure message names the module by. */
  readonly displayPath: string;
  /** One-based, so a failure reads like an editor's own location. */
  readonly line: number;
  /** The method argument as written — a literal, a constant, or a parameter name. */
  readonly methodExpression: string;
  /** Every method this call can name, or `[]` where none was resolved. */
  readonly resolvedMethods: readonly string[];
  /** What the options argument shows about the signal that stops this call. */
  readonly signalArgument: SignalArgumentReading;
}

/**
 * Every door call in one module, with its method resolved and its signal read.
 *
 * ONE PARSE, THREE MODELS OVER IT. The scope chain is built once by
 * `daemon-method-bindings.ts` and the calls are found by one walk; a call resolves
 * both the callee and the method argument against the scopes that contain its own
 * position, which is what makes an inner binding shadow an outer parameter rather than
 * the other way round.
 */
export function daemonCallSitesIn(
  displayPath: string,
  source: string,
  constants: DaemonMethodConstantIndex,
): readonly DaemonCallSite[] {
  const parsed = parseSourceText(displayPath, source);
  const bindings = new ModuleBindingScopes(parsed);
  const calls: ts.CallExpression[] = [];

  forEachDescendant(parsed, (node) => {
    if (ts.isCallExpression(node) && isCallDoor(node, parsed, bindings)) {
      calls.push(node);
    }
  });

  return calls.map((call) => {
    const method = call.arguments[METHOD_ARGUMENT_INDEX];
    const callStart = call.getStart(parsed);
    return {
      displayPath,
      line: parsed.getLineAndCharacterOfPosition(callStart).line + 1,
      methodExpression: method === undefined ? "" : method.getText(parsed),
      resolvedMethods: resolveMethods(method, displayPath, callStart, bindings, constants),
      signalArgument: readSignalArgument(
        call.arguments[OPTIONS_ARGUMENT_INDEX],
        callStart,
        bindings,
      ),
    };
  });
}

/**
 * Whether a call's callee is the door itself, through the binding at its own position.
 *
 * AN IMPORT SPECIFIER AND NOTHING ELSE. The door is a value another module exports, so
 * the only way a call in this module can name it is a specifier that imported it —
 * under the exported spelling or under whatever the clause aliased it to, which is the
 * `propertyName ?? name` reading `daemon-call-census.ts` states for the same clause.
 * Resolving the callee first is what makes a shadow a shadow: a parameter named `send`
 * binds nearer than the module's `import { callDaemon as send }`, so the call it makes
 * is that parameter's and not the door's, exactly as the language would run it.
 *
 * A module that spells `callDaemon` and imports nothing therefore contributes no
 * calls — the name resolves to no binding at all — which is the honest answer rather
 * than an exemption: such a module has no door to reach and no call of its own to hide.
 */
function isCallDoor(
  call: ts.CallExpression,
  parsed: ts.SourceFile,
  bindings: ModuleBindingScopes,
): boolean {
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) {
    return false;
  }
  const declaration = bindings.resolve(callee.text, call.getStart(parsed))?.declaration;
  return (
    declaration !== undefined &&
    ts.isImportSpecifier(declaration) &&
    (declaration.propertyName ?? declaration.name).text === CALL_DOOR_EXPORT
  );
}

/**
 * Every method the method argument can name, through the binding the call sees.
 *
 * A literal names itself. An identifier is resolved against the scope chain at the
 * call's own position: a parameter's declared union and a `const`'s own string literal
 * answer directly, an import is asked of the cross-module constant index under the
 * MODULE it names and the name it was EXPORTED as, and a binding this parse cannot
 * reduce answers nothing rather than falling through to a repository-wide search for
 * the same spelling.
 */
function resolveMethods(
  method: ts.Expression | undefined,
  displayPath: string,
  callStart: number,
  bindings: ModuleBindingScopes,
  constants: DaemonMethodConstantIndex,
): readonly string[] {
  if (method === undefined) {
    return [];
  }
  const named = withoutTypeWrappers(method);
  if (ts.isStringLiteralLike(named)) {
    return [named.text];
  }
  if (!ts.isIdentifier(named)) {
    return [];
  }
  const binding = bindings.resolve(named.text, callStart)?.method;
  if (binding === undefined || binding.kind === "unreadable") {
    return [];
  }
  return binding.kind === "literals"
    ? binding.literals
    : constants.resolve(displayPath, binding.moduleSpecifier, binding.exportedName);
}
