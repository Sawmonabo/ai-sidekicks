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
// AND THE DOOR IS THE BINDING THE CALL SEES, not a name in a set — which is the same
// defect the method resolution below refuses, refused the same way: the callee is
// resolved through `daemon-method-bindings.ts` at the call's own position, and it is a
// door call only where that resolution lands on an import of the door. A module holding
// no such import contributes no calls, which is what it means for a module not to reach
// the door. What "an import of the door" admits — a named specifier under any alias, a
// namespace the door is read off, and nothing else — is `daemon-call-census.ts`'
// `namesCallDoor`, stated in that module's header beside the consumer census that makes
// the same reading of the same bindings, rather than restated here where it would be
// one rule in two headers and would move in one.
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
import { namesCallDoor } from "./daemon-call-census.js";
import { ModuleBindingScopes } from "./daemon-method-bindings.js";
import { DaemonMethodConstantIndex } from "./daemon-method-constants.js";
import { withoutTypeWrappers } from "./daemon-method-literals.js";
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
    if (
      ts.isCallExpression(node) &&
      namesCallDoor(node.expression, node.getStart(parsed), bindings)
    ) {
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
