// What a door call HANDS the door in place of a signal, read off the options literal.
//
// A SUBJECT OF ITS OWN, beside the method one. `daemon-call-sites.ts` answers which
// calls reach the door and what each of them NAMES; this answers what each of them
// SHOWS about the thing that stops it. The two questions share the scope chain and
// nothing else — the method reading is about a string the registry classifies, and
// this one is about a value's provenance — and holding them apart is what keeps
// either from being explained in the other's terms.
//
// THE READING IS FOUR-VALUED, because a boolean answered `false` both for an options
// object this parse READ and found no signal in and for one it could not read at all
// — which is fail-closed for a read and fail-OPEN for a record, whose rule is that no
// signal was passed. `{ ...options }` and a held variable are `"opaque"`, and both
// rules refuse them: a read must SHOW its signal and a record must SHOW it has none.
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
// AND THE WHOLE LITERAL IS SCANNED, NEVER JUST UP TO THE SIGNAL. Returning at the
// first `signal` member read `{ signal: round.signal, ...options }` as `"present"`,
// and that call hands the door whatever the SPREAD carries — the later contribution
// wins, so a member the parse could see was overwritten by one it could not. The fix
// is not to look one property further: it is that a literal mixing a shown signal
// with an unshowable contribution has not SHOWN what the door receives, whichever
// order the two are written in. Making the verdict depend on that order would put a
// property-precedence rule inside a tripwire whose whole value is that a person can
// read the call and see the answer, and would let a later edit that merely REORDERS
// the literal flip a call from compliant to unsafe with no change to its signal at
// all. So a spread or a computed key anywhere in a signal-bearing literal answers
// `"unrecognised"`, and the fix is at the call: hoist the spread into the value the
// signal is read from, or hand the door a literal that says what it hands.
//
// THE HONEST LIMIT. A forwarded parameter is trusted one hop: this scan reads the
// call, not the caller, so a helper handed a dead signal is a defect at the site that
// handed it one. That hop is where the console's own line ends too — the round is
// minted by the scope and handed down — which is why the accepted set is the round and
// the forwarded parameter rather than a re-derivation of the whole call graph.

import ts from "typescript";

import { type ModuleBindingScopes, type NameBinding } from "./daemon-method-bindings.js";
import { withoutTypeWrappers } from "./daemon-method-literals.js";

/** The member of a call's options that stops a read, and the member a round publishes it as. */
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
 * alone admits a signal that stops nothing — and it is read only where nothing else in
 * the literal could have replaced it, for the reason this module's header gives.
 */
export function readSignalArgument(
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
  let unreadable = false;
  let signalMember: ts.ObjectLiteralElementLike | undefined;
  for (const property of named.properties) {
    if (namesSignalMember(property)) {
      // The last one wins, exactly as the language says: a literal that assigns the
      // member twice hands the door the second value.
      signalMember = property;
    } else if (isUnreadableMember(property)) {
      unreadable = true;
    }
  }
  if (signalMember === undefined) {
    return unreadable ? "opaque" : "absent";
  }
  return unreadable
    ? "unrecognised"
    : readSignalValue(signalValueOf(signalMember), callStart, bindings);
}

/** Whether this member is named {@link SIGNAL_MEMBER}, in the two spellings a key has. */
function namesSignalMember(property: ts.ObjectLiteralElementLike): boolean {
  const name = property.name;
  return (
    name !== undefined &&
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
    name.text === SIGNAL_MEMBER
  );
}

/**
 * Whether this member could contribute a signal member this parse cannot see.
 *
 * A spread carries whatever its source holds, and a computed key is a name decided at
 * run time — either of which can be the `signal` the door actually receives, and
 * neither of which this parse can enumerate.
 */
function isUnreadableMember(property: ts.ObjectLiteralElementLike): boolean {
  return (
    ts.isSpreadAssignment(property) ||
    property.name === undefined ||
    ts.isComputedPropertyName(property.name)
  );
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
