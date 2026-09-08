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
// gate gives such a site a reading of its own that no options argument can satisfy —
// because a call that could name a read is a defect whatever it was handed, and
// whether or not today's callers happen to pass a mutation. The alternative reading,
// exempting what it cannot classify, is the hole this whole file exists to close.
//
// AND THE SIGNAL ARGUMENT IS FOUR-VALUED FOR THE SAME REASON. A boolean answered
// `false` both for an options object this parse READ and found no signal in and for
// one it could not read at all — which is fail-closed for a read and fail-OPEN for a
// record, whose rule is that no signal was passed. `{ ...options }` and a held
// variable are now `"opaque"`, and both rules refuse it: a read must SHOW its signal
// and a record must SHOW it has none.
//
// THE FOURTH VALUE IS THE ONE A KEY CHECK CANNOT GIVE. A member NAMED `signal` is not
// a signal that stops this read: `{ signal: AbortSignal.abort() }` is aborted before
// the call and stops nothing that ever ran, and `{ signal: controller.signal }` off a
// controller minted in the same function is a line nothing supersedes and nothing
// abandons — both were `"present"` while the property name was the whole test. So the
// VALUE is resolved, against the two forms the console's own read line actually
// produces (`store/read-cancellation.ts`): a round's signal, `round.signal`, off a
// name bound either to a `ReadRound` parameter or to a local a `.openRound()` was
// opened into; and a FORWARDED one, the bare `signal` a read helper took as its own
// parameter — annotated `AbortSignal` at the eleven `repos` and inventory helpers,
// contextually typed at the `read: async (signal) => …` arrows a push-driven read
// hands its round's signal to. Anything else is `"unrecognised"`, which both rules
// refuse for the reason `"opaque"` is refused: the read has not shown what stops it,
// and the record has not shown it carries none.
//
// THE HONEST LIMIT, IN BOTH DIRECTIONS. The door is matched by the local names this
// module's own imports bind it to — the aliased spelling included, since
// `daemon-call-census.ts` resolves that clause and this scan asks it rather than
// re-reading it — so what stays invisible is a door reached through a value handed in
// from somewhere else, which is the same depth limit the reach census states. And a
// forwarded parameter is trusted one hop: this scan reads the call, not the caller, so
// a helper handed a dead signal is a defect at the site that handed it one. That hop
// is where the console's own line ends too — the round is minted by the scope and
// handed down — which is why the accepted set is the round and the forwarded
// parameter rather than a re-derivation of the whole call graph.

import ts from "typescript";

import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import { CALL_DOOR_EXPORT, callDoorLocalNames } from "./daemon-call-census.js";
import {
  ModuleBindingScopes,
  withoutTypeWrappers,
  type DaemonMethodConstantIndex,
  type NameBinding,
} from "./daemon-method-bindings.js";

/** Where the method name sits in the door's argument list. */
const METHOD_ARGUMENT_INDEX = 1;

/** Where `DaemonCallOptions` sits in it. */
const OPTIONS_ARGUMENT_INDEX = 3;

/** The member of those options that stops a read, and the member a round publishes it as. */
const SIGNAL_MEMBER = "signal";

/** What a forwarded signal parameter declares itself as, where it declares anything. */
const SIGNAL_TYPE = "AbortSignal";

/** What a held round declares itself as, where it was handed in rather than opened. */
const READ_ROUND_TYPE = "ReadRound";

/** The scope's own factory, where a round is opened here rather than handed in. */
const ROUND_FACTORY = "openRound";

/**
 * What a call's options argument SHOWS about the signal.
 *
 * Four, because each pair of them is two different facts: "this parse read the options
 * and found no signal" and "this parse could not read the options" differ, and so do
 * "the value is a signal that stops this read" and "the member is merely NAMED
 * `signal`". Only one of the four is evidence for the read rule and only one is
 * evidence for the record rule, and they are not the same one.
 */
export type SignalArgumentReading = "present" | "absent" | "opaque" | "unrecognised";

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
      signalArgument: readSignalArgument(
        call.arguments[OPTIONS_ARGUMENT_INDEX],
        call.getStart(parsed),
        bindings,
      ),
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
 * READ, NOT READ, OR UNREADABLE, and then what the value IS. An object literal this
 * parse can enumerate answers `"absent"` where it holds no signal member — that is
 * evidence, and it is the record rule's evidence. A spread, a computed key, a held
 * variable, or any other expression answers `"opaque"`, because none of them lets this
 * parse SEE what is in there, and the two rules need opposite evidence: a read has to
 * show a signal and a record has to show none. Collapsing "unreadable" into "absent"
 * made the record rule pass on a call that could be handing one.
 *
 * A signal member is then read for its VALUE rather than counted, because the key
 * alone admits a signal that stops nothing.
 */
function readSignalArgument(
  options: ts.Expression | undefined,
  callStart: number,
  bindings: ModuleBindingScopes,
): SignalArgumentReading {
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
      return readSignalValue(signalValueOf(property), callStart, bindings);
    }
  }
  return opaque ? "opaque" : "absent";
}

/**
 * The expression a signal member is assigned, in the two spellings an object literal
 * has for it — `{ signal }` names the identifier itself, `{ signal: x }` names `x`.
 *
 * A method or accessor declaration named `signal` answers nothing: it is a member with
 * that name and no value expression at all, which is the shape a value check has to
 * refuse rather than crash on.
 */
function signalValueOf(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

/**
 * Whether this value is a signal that can stop the read the call is making.
 *
 * Two forms answer `"present"` and everything else is `"unrecognised"`: a round's own
 * `signal` member, off a name bound to a round; and a bare identifier bound to a
 * parameter of an enclosing function, which is a signal the CALLER supplied. A
 * `new AbortController().signal`, an `AbortSignal.abort()`, a module-level const and a
 * destructured local are none of those — and each of them is a line that would satisfy
 * a key check while stopping nothing this scope ever supersedes.
 */
function readSignalValue(
  value: ts.Expression | undefined,
  callStart: number,
  bindings: ModuleBindingScopes,
): SignalArgumentReading {
  if (value === undefined) {
    return "unrecognised";
  }
  const named = withoutTypeWrappers(value);
  if (ts.isIdentifier(named)) {
    return isForwardedSignal(bindings.resolve(named.text, callStart)) ? "present" : "unrecognised";
  }
  if (
    ts.isPropertyAccessExpression(named) &&
    named.name.text === SIGNAL_MEMBER &&
    ts.isIdentifier(named.expression)
  ) {
    return isHeldReadRound(bindings.resolve(named.expression.text, callStart))
      ? "present"
      : "unrecognised";
  }
  return "unrecognised";
}

/**
 * Whether this binding is a signal the caller handed in.
 *
 * A PARAMETER, and its declared type where it declares one: the console's read helpers
 * annotate `signal: AbortSignal`, and the arrow a push-driven read calls with its
 * round's signal declares nothing because the seat's own option type declares it for
 * them. A parameter typed as anything else is refused rather than admitted on the
 * strength of being a parameter.
 */
function isForwardedSignal(binding: NameBinding | undefined): boolean {
  if (binding === undefined || !ts.isParameter(binding.declaration)) {
    return false;
  }
  const declared = binding.declaration.type;
  return declared === undefined || namesType(declared, SIGNAL_TYPE);
}

/**
 * Whether this binding is a read round: the only thing whose `signal` member stops a
 * read on this line.
 *
 * The two forms `store/read-cancellation.ts` produces — a `ReadRound` a performer took
 * as its parameter, and a local the scope's own `openRound()` was opened into.
 */
function isHeldReadRound(binding: NameBinding | undefined): boolean {
  if (binding === undefined) {
    return false;
  }
  const { declaration } = binding;
  if (ts.isParameter(declaration)) {
    return namesType(declaration.type, READ_ROUND_TYPE);
  }
  return ts.isVariableDeclaration(declaration) && opensRound(declaration.initializer);
}

/** Whether a declared type names `typeName`, which is how both forms above declare. */
function namesType(type: ts.TypeNode | undefined, typeName: string): boolean {
  return (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === typeName
  );
}

/** Whether an initializer opened a round off a scope: `<scope>.openRound()`. */
function opensRound(initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) {
    return false;
  }
  const called = withoutTypeWrappers(initializer);
  return (
    ts.isCallExpression(called) &&
    ts.isPropertyAccessExpression(called.expression) &&
    called.expression.name.text === ROUND_FACTORY
  );
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
  const binding = bindings.resolve(named.text, callStart)?.method;
  if (binding === undefined || binding.kind === "unreadable") {
    return [];
  }
  return binding.kind === "literals" ? binding.literals : constants.resolve(binding.exportedName);
}
