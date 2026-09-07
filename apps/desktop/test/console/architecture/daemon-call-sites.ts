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
// AND THE METHOD IS RESOLVED RATHER THAN REQUIRED TO BE A LITERAL — through the
// LEXICAL binding the call actually names, which `daemon-method-bindings.ts` models.
// Ten of the console's call sites name a module constant, one names a parameter typed
// as a union of two literals, and one names a generic type parameter, so a scan that
// read only string literals would report two thirds of the console unclassifiable and
// be ignored. What resolves them is the scope chain and not a name index: the first
// enclosing scope that binds the identifier is the answer, so an inner binding shadows
// an outer one exactly as the language says it does.
//
// WHAT IS DELIBERATELY UNRESOLVED, and why that is the fail-closed direction. A method
// this parse cannot reduce to a set of names is reported with an empty set, and the
// gate holds such a site to the READ rule — because a call that could name a read and
// hands the door nothing to stop it is the defect whether or not today's callers
// happen to pass a mutation. The alternative reading, exempting what it cannot
// classify, is the hole this whole file exists to close.
//
// AND THE SIGNAL ARGUMENT IS THREE-VALUED FOR THE SAME REASON. A boolean answered
// `false` both for an options object this parse READ and found no signal in and for
// one it could not read at all — which is fail-closed for a read and fail-OPEN for a
// record, whose rule is that no signal was passed. `{ ...options }` and a held
// variable are now `"opaque"`, and both rules refuse it: a read must SHOW its signal
// and a record must SHOW it has none.
//
// THE HONEST LIMIT. The door is matched by the local names this module's own imports
// bind it to — the aliased spelling included, since `daemon-call-census.ts` resolves
// that clause and this scan asks it rather than re-reading it — so what stays
// invisible is a door reached through a value handed in from somewhere else, which is
// the same depth limit the reach census states.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { CALL_DOOR_EXPORT, callDoorLocalNames } from "./daemon-call-census.js";
import {
  ModuleBindingScopes,
  withoutTypeWrappers,
  type DaemonMethodConstantIndex,
} from "./daemon-method-bindings.js";

/** Where the method name sits in the door's argument list. */
const METHOD_ARGUMENT_INDEX = 1;

/** Where `DaemonCallOptions` sits in it. */
const OPTIONS_ARGUMENT_INDEX = 3;

/** The member of those options that stops a read. */
const SIGNAL_MEMBER = "signal";

/**
 * What a call's options argument SHOWS about the signal.
 *
 * Three, because "this parse read the options and found no signal" and "this parse
 * could not read the options" are different facts and only one of them is evidence.
 */
export type SignalArgumentReading = "present" | "absent" | "opaque";

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
  /** What the options argument shows about {@link SIGNAL_MEMBER}. */
  readonly signalArgument: SignalArgumentReading;
}

/**
 * Every door call in one module, with its method resolved and its signal read.
 *
 * ONE PARSE, TWO MODELS OVER IT. The scope chain is built once by
 * `daemon-method-bindings.ts` and the calls are found by one walk; a call resolves its
 * identifier against the scopes that contain its own position, which is what makes an
 * inner binding shadow an outer parameter rather than the other way round.
 */
export function daemonCallSitesIn(
  displayPath: string,
  source: string,
  constants: DaemonMethodConstantIndex,
): readonly DaemonCallSite[] {
  const parsed = parseSourceText(displayPath, source);
  const doorNames = new Set<string>([CALL_DOOR_EXPORT, ...callDoorLocalNames(parsed)]);
  const bindings = new ModuleBindingScopes(parsed);
  const calls: ts.CallExpression[] = [];

  forEachDescendant(parsed, (node) => {
    if (ts.isCallExpression(node) && isCallDoor(node.expression, doorNames)) {
      calls.push(node);
    }
  });

  return calls.map((call) => {
    const method = call.arguments[METHOD_ARGUMENT_INDEX];
    return {
      displayPath,
      line: parsed.getLineAndCharacterOfPosition(call.getStart(parsed)).line + 1,
      methodExpression: method === undefined ? "" : method.getText(parsed),
      resolvedMethods: resolveMethods(method, call.getStart(parsed), bindings, constants),
      signalArgument: readSignalArgument(call.arguments[OPTIONS_ARGUMENT_INDEX]),
    };
  });
}

/**
 * Whether a call's callee is the door itself.
 *
 * `doorNames` is the exported spelling plus whatever this module's own import clause
 * renamed it to. Matching only the export dropped every call in a module that wrote
 * `import { callDaemon as send }` while the consumer census — which reads that same
 * clause — still counted the module, so the signal check ran over nothing and reported
 * a clean result.
 */
function isCallDoor(callee: ts.Expression, doorNames: ReadonlySet<string>): boolean {
  return ts.isIdentifier(callee) && doorNames.has(callee.text);
}

/**
 * What the options argument shows about the signal member.
 *
 * READ, NOT READ, OR UNREADABLE. An object literal this parse can enumerate answers
 * `"present"` or `"absent"` — both are evidence. A spread, a computed key, a held
 * variable, or any other expression answers `"opaque"`, because none of them lets this
 * parse SEE what is in there, and the two rules above need opposite evidence: a read
 * has to show a signal and a record has to show none. Collapsing "unreadable" into
 * "absent" made the record rule pass on a call that could be handing one.
 */
function readSignalArgument(options: ts.Expression | undefined): SignalArgumentReading {
  if (options === undefined) {
    return "absent";
  }
  const named = withoutTypeWrappers(options);
  if (!ts.isObjectLiteralExpression(named)) {
    return "opaque";
  }
  let opaque = false;
  for (const property of named.properties) {
    if (ts.isSpreadAssignment(property)) {
      opaque = true;
      continue;
    }
    const name = property.name;
    if (name === undefined || ts.isComputedPropertyName(name)) {
      opaque = true;
      continue;
    }
    if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === SIGNAL_MEMBER) {
      return "present";
    }
  }
  return opaque ? "opaque" : "absent";
}

/**
 * Every method the method argument can name, through the binding the call sees.
 *
 * A literal names itself. An identifier is resolved against the scope chain at the
 * call's own position: a parameter's declared union and a `const`'s own string literal
 * answer directly, an import is asked of the cross-module constant index under the
 * name it was EXPORTED as, and a binding this parse cannot reduce answers nothing
 * rather than falling through to a repository-wide search for the same spelling.
 */
function resolveMethods(
  method: ts.Expression | undefined,
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
  const binding = bindings.resolve(named.text, callStart);
  if (binding === undefined || binding.kind === "unreadable") {
    return [];
  }
  return binding.kind === "literals" ? binding.literals : constants.resolve(binding.exportedName);
}
