// The one door every growth-port call in this family goes through, and the vocabulary
// it refuses in.
//
// A CALL THAT REJECTS IS AN ANSWER, AND THE PORT'S OWN UNION CANNOT SAY SO. The live
// bridge crosses a process boundary, so an IPC disconnect makes a call THROW rather
// than answer a refusal — and `growthAnswerReading` is total over what a call ANSWERS
// and is never reached by one that threw. Three halves of this family learned that the
// same way: the artifact acts left a fetch on the `fetching` arm forever, the artifact
// reader's two legs were joined by a `Promise.all` that took the whole refresh down
// when either one rejected, and the proposal gate re-enabled every control with nothing
// written beside the one that was pressed.
//
// SO IT IS ONE FUNCTION AND NOT THREE, AND IT LIVES AT THE FAMILY ROOT. It began under
// `artifact-pane/` with that pane as its only caller; the proposal gate is the second,
// and `apps/desktop/AGENTS.md` hoists a helper on its second use. Written twice, the
// two copies would be two chances to relabel a code the console is not allowed to
// paraphrase — which is exactly what the second copy did.
//
// THROUGH THE CONSOLE'S NORMALIZER RATHER THAN A SECOND ONE. `core/wire-rejection.ts`
// owns turning a rejection into this console's one refusal shape, and its arm ordering
// is what matters: a value that already IS a `ConsoleRefusal` — which the fixture
// bridge throws — passes through with the origin it named, and a JSON-RPC envelope's
// dotted project code and a flat envelope's code and message are kept verbatim. Only
// the remainder reaches the fallback below.
//
// AND THE FALLBACK IS THE PORT'S OWN VOCABULARY, WHICH IT WAS NOT. Both call sites used
// to reach for `repoCallRefusal`, so a rejected `artifactRead` or `gitActionExecute`
// rendered `origin: "repos"` with `code: "call-rejected"` — the repos family's
// daemon-read origin and the DAEMON REPLY vocabulary — while the same operation's
// ANSWERED refusal rendered `origin: "growth-port"` with `code: "wire-unregistered"`.
// One operation, two failure paths, two subsystem names, and neither the origin nor
// the code on the second was a member of the set the growth port declares. Both paths
// now stamp `GROWTH_PORT_REFUSAL_ORIGIN`, and the code is the port's own
// `wire-unregistered`: a growth call reaches the port through a namespace the live
// bridge fills in, so the throw this catches is that namespace being gone, which is
// what that member means. The DETAIL is what separates the two — an answered refusal
// says nobody asked, and this one says the call was rejected.
//
// THE THUNK RATHER THAN A PROMISE: a bridge whose namespace is gone can throw
// synchronously, and a promise parameter would have to be built outside the `try` to
// be passed in — which is exactly the call this exists to catch.

import {
  GROWTH_PORT_REFUSAL_ORIGIN,
  type GrowthPortRefusalCode,
  type GrowthUnavailable,
} from "../bridge/index.js";
import {
  isConsoleRefusal,
  normalizeWireRejection,
  refuse,
  type ConsoleRefusal,
} from "../core/index.js";

/**
 * Which subsystem refused, when the refusal is this door's own and not the port's.
 *
 * A THIRD ORIGIN BESIDE `repos` AND `growth-port`, and each of the three names a
 * different author. `repos` is the family's DAEMON reads (`repo-reads.ts`), the port
 * names itself on every answer it composes, and this one is the console's own reading
 * of an answer it could not use. Stamping either of the other two would attribute the
 * refusal to something that did not raise it.
 */
export const GROWTH_CALL_REFUSAL_ORIGIN = "repos-growth-call";

/**
 * The codes this door mints. The port owns every other refusal a growth call produces.
 *
 * ONE ARRAY AND NO COUNT IN PROSE, on `artifact-pane-refusals.ts`'s rule and for its
 * reason: a number in a sentence is not something a second code can fail against.
 * Exactly one member today, and the literal below is `satisfies`-checked against the
 * union so the closed vocabulary binds rather than decorates.
 */
export const GROWTH_CALL_REFUSAL_CODES = ["reply-unreadable"] as const;

/** One code this door mints. Derived, so the vocabulary is declared exactly once. */
export type GrowthCallRefusalCode = (typeof GROWTH_CALL_REFUSAL_CODES)[number];

/**
 * The refusal a reply this console cannot read becomes.
 *
 * TWO SITES RAISE IT AND SO IT IS DECLARED ONCE. `growthAnswerReading` below raises it
 * for an answer that is neither a served value nor a refusal, and
 * `artifact-pane-reads.ts` for a served `value` whose SHAPE the leg cannot use — an
 * `artifactList` that is not an array, a bounds reply with no content types. Both are
 * the same fact about the same wire and neither is a rejection, so a caller narrowing
 * on the code should not have to know which of the two saw it first.
 *
 * THE REPLY IS NOT QUOTED INTO THE SENTENCE: what arrived can carry participant
 * content, so the sentence names the operation and what was expected of it and stops
 * there. `Spec-023 §Console Design (Meridian)` rule 9 is the rule.
 */
export function replyUnreadableRefusal(operation: string, expected: string): ConsoleRefusal {
  return refuse(
    GROWTH_CALL_REFUSAL_ORIGIN,
    "reply-unreadable" satisfies GrowthCallRefusalCode,
    `${operation} answered with ${expected}, so nothing was read.`,
  );
}

/**
 * The refusal a growth call that REJECTED becomes.
 *
 * Exported beside the door that uses it because an act can hold a growth call inside a
 * wider `try` — the proposal gate's dispatch also awaits an identity read and builds a
 * request — and a second stamp written at that backstop would be the copy this module
 * exists to have removed.
 */
export function growthCallRejectionRefusal(operation: string, rejection: unknown): ConsoleRefusal {
  return normalizeWireRejection(GROWTH_PORT_REFUSAL_ORIGIN, rejection, {
    code: "wire-unregistered" satisfies GrowthPortRefusalCode,
    detail: `${operation} was rejected.`,
  });
}

/**
 * One growth-port answer, in the two arms the port produces.
 *
 * The served arm is written out rather than imported because `GrowthOutcome` does not
 * leave the bridge barrel, and a view family reaching past that barrel is the deep
 * import the structure rules exist to prevent. `GrowthUnavailable` does leave it, so
 * the arm that carries a vocabulary is the port's own value and only the two-member
 * served arm is restated — and a served arm that lost `value` would fail to assign at
 * every call site rather than drifting quietly.
 */
export type GrowthAnswer<TValue> =
  | { readonly status: "served"; readonly value: TValue }
  | GrowthUnavailable;

/**
 * What one growth-port answer said, or why nothing was read.
 *
 * `repos/repo-reads.ts`'s read-or-refusal shape, because it is the same question asked
 * of a different port: a second vocabulary for it would make a surface rendering both
 * translate between two shapes to reach one renderer, which is exactly what
 * `core/refusal.ts` exists to have stopped.
 */
export type GrowthAnswerReading<TValue> =
  | { readonly status: "read"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Read one growth-port answer, by the shape the reply actually has.
 *
 * NARROWED ON THE REFUSAL, NOT ON ONE DISCRIMINANT VALUE'S ABSENCE. Every call site in
 * the artifact pane used to ask `status === "unavailable"` and treat everything else as
 * served. That is not the same claim, and the difference is reachable: `core`'s bare
 * `refuse(...)` is a refusal WITHOUT the port's discriminant — `growthUnavailable`
 * builds its own by spreading exactly that value — so such a reply passed the test as
 * served and was then dereferenced for a `value` it does not carry. The pane published
 * `read-threw` carrying a `TypeError` sentence, which made a wire that is simply not
 * registered read as the console breaking, and buried the refusal that said so.
 *
 * MOST SPECIFIC FIRST, which is `core/wire-rejection.ts`'s own arm ordering: a reply
 * that already IS the console's one refusal shape is one, and `GrowthUnavailable`
 * extends that shape, so the port's own refusal and a bare `refuse(...)` are recognised
 * by the same test and neither reaches the value branch. A served answer carries no
 * `code`, `detail`, or `origin`, so it cannot be mistaken for one in the other
 * direction.
 *
 * TOTAL, because a reply that is neither is a fact rather than a crash. Rule 8 admits
 * no silent no-op, so the third arm is a refusal a person can read and paste, naming
 * the operation and never the reply — which may be participant content.
 */
export function growthAnswerReading<TValue>(
  operation: string,
  answer: GrowthAnswer<TValue>,
): GrowthAnswerReading<TValue> {
  if (isConsoleRefusal(answer)) {
    return { status: "refused", refusal: answer };
  }
  if (!carriesServedValue(answer)) {
    return {
      status: "refused",
      refusal: replyUnreadableRefusal(
        operation,
        "a shape that is neither a served value nor a refusal",
      ),
    };
  }
  return { status: "read", value: answer.value };
}

/**
 * Whether an answer the types call served actually carries the member.
 *
 * The check the declared type cannot make: the fixture bridge is assembled behind a
 * cast, and the live port is one process boundary away, so what arrives is whatever
 * was sent. Presence rather than definedness — no operation in this family serves an
 * absent value, and testing for `undefined` would refuse one that legitimately did.
 */
function carriesServedValue(answer: unknown): answer is { readonly value: unknown } {
  return typeof answer === "object" && answer !== null && "value" in answer;
}

/** Put one call to the port and read what came back — including a rejection. */
export async function readGrowthAnswer<TValue>(
  operation: string,
  call: () => Promise<GrowthAnswer<TValue>>,
): Promise<GrowthAnswerReading<TValue>> {
  try {
    return growthAnswerReading(operation, await call());
  } catch (rejection) {
    return { status: "refused", refusal: growthCallRejectionRefusal(operation, rejection) };
  }
}
