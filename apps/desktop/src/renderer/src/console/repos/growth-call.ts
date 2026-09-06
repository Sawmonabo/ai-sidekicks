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
// AND READING A REJECTION IS TOTAL, WHICH IS WHY THE `catch` CAN COMPOSE AT ALL.
// `core/wire-rejection.ts` answers a refusal for every input and throws for none —
// a `ConsoleRefusalError` the fixture bridge threw, a wire envelope that crossed the
// preload boundary as a plain object, a thrown primitive, a revoked Proxy. Without
// that guarantee the one function a surface calls to say something failed would be
// the second place it failed.
//
// AND THE REJECTED PATH IS THE PORT'S OWN BUILDER, NOT A STAMP OF THIS DOOR'S. Both
// call sites used to reach for `repoCallRefusal`, so a rejected `artifactRead` or
// `gitActionExecute` rendered `origin: "repos"` with the family's DAEMON-reply
// vocabulary while the same operation's ANSWERED refusal rendered
// `origin: "growth-port"` — one operation, two failure paths, two subsystem names. This
// door then answered that by minting a growth-port refusal of its own, which is the
// same defect one layer in: `bridge/growth-port/growth-port.ts` publishes
// `growthUnavailableFromRejection` for exactly this case and its own header says it
// exists so that a caller does not mint one. The rejection goes to that builder.
//
// WHICH SETTLES THREE THINGS THIS DOOR USED TO DECIDE FOR ITSELF, each of them wrongly.
// The CODE is `call-rejected`, the member of `GROWTH_PORT_REFUSAL_CODES` that says a
// call was MADE and threw, where the `wire-unregistered` this door stamped says nobody
// asked at all — one is an outage and the other is the ordinary V1 answer, and they are
// different next moves. The SHAPE is a `GrowthUnavailable`, so a rejected call carries
// the operation, its slate row and who owes the wire, exactly as an answered refusal
// does rather than arriving as a bare refusal a growth surface cannot narrow. And the
// rejection's own SENTENCE travels, because that builder keeps
// `normalizeWireRejection`'s `detail`: the normalizer already refuses to serialize a
// structure into a sentence (`core/wire-rejection.ts` states the rule), so what reaches
// a person is prose the producing side wrote — and this door's constant suppressed the
// only reason there was. What the builder discards is the rejection's CODE, and keeping
// that is what this family had wrong in the other direction: a thrown `ConsoleRefusal`
// arrived under the port's origin carrying a code from no vocabulary that port declares.
//
// THE THUNK RATHER THAN A PROMISE: a bridge whose namespace is gone can throw
// synchronously, and a promise parameter would have to be built outside the `try` to
// be passed in — which is exactly the call this exists to catch.

import {
  growthUnavailableFromRejection,
  type GrowthOperationId,
  type GrowthUnavailable,
} from "../bridge/index.js";
import { isConsoleRefusal, refuse, type ConsoleRefusal } from "../core/index.js";

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
 * content, so the sentence names the leg and what was expected of it and stops
 * there. `Spec-023 §Console Design (Meridian)` rule 9 is the rule.
 */
export function replyUnreadableRefusal(legName: string, expected: string): ConsoleRefusal {
  return refuse(
    GROWTH_CALL_REFUSAL_ORIGIN,
    "reply-unreadable" satisfies GrowthCallRefusalCode,
    `${legName} answered with ${expected}, so nothing was read.`,
  );
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
 * the leg and never the reply — which may be participant content.
 */
export function growthAnswerReading<TValue>(
  legName: string,
  answer: GrowthAnswer<TValue>,
): GrowthAnswerReading<TValue> {
  if (isConsoleRefusal(answer)) {
    return { status: "refused", refusal: answer };
  }
  if (!carriesServedValue(answer)) {
    return {
      status: "refused",
      refusal: replyUnreadableRefusal(
        legName,
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

/**
 * Put one call to the port and read what came back — including a rejection.
 *
 * TWO NAMES FOR ONE CALL, ANSWERING TO DIFFERENT AUTHORITIES. `operationId` is the
 * PORT's key: it is what `growthUnavailableFromRejection` looks the slate row up by, so
 * the wire a rejected call names is derived from the operation the call was actually
 * made on rather than from a string a caller wrote beside it. `legName` is this
 * console's own name for the read, and it reaches only the sentence this door mints for
 * a reply it could not use — where the port has no opinion, because nothing about that
 * reply is the port's. Neither is derivable from the other: `artifactRead` serves two
 * legs in this family, the payload fetch and the per-row manifest re-read. The types
 * keep the pair the right way round, a `GrowthOperationId` being a closed union where a
 * leg name is any string.
 */
export async function readGrowthAnswer<TValue>(
  operationId: GrowthOperationId,
  legName: string,
  call: () => Promise<GrowthAnswer<TValue>>,
): Promise<GrowthAnswerReading<TValue>> {
  try {
    return growthAnswerReading(legName, await call());
  } catch (rejection) {
    return { status: "refused", refusal: growthUnavailableFromRejection(operationId, rejection) };
  }
}
