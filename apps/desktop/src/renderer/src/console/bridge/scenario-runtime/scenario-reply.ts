// The reply table a scenario scripts: what a request/response call is answered with.
//
// WHAT IS NOT HERE. The scenario itself, which is `scenario.ts`. The two were one file
// until it grew past the ~400-line rule `apps/desktop/AGENTS.md` sets, and the seam
// that growth was crossing is the one between two independent type groups: WHO a
// scenario is about and WHAT IT PLAYS, against how one CALL into it settles. A reader
// reaching for the reply table is asking a question about a single call — which of the
// three arms it takes, what a computed one is handed, what shape a refusal arrives in
// — and every one of those answers is here, with no reading of the scenario's own
// roster, clock, or frame tables in front of it.
//
// The split is load-bearing rather than tidy. `scripted-reply.ts` settles one of these
// and names nothing else in `scenario.ts`; `wire-truth/reply-walk.ts` holds every
// scripted reply in the tree to the wire's own truth and reads no other member of a
// scenario; and a family branch adding a `readonly ScenarioReply[]` table under
// `scenarios/` takes this module and not the shape beside it.

import type { WireErrorEnvelope } from "../../core/index.js";

/** What every canned reply carries, whichever way it settles. */
interface ScenarioReplyBase {
  /** The daemon method or control-plane procedure name, verbatim. */
  readonly call: string;
  /**
   * Simulated latency, so a loading state is reachable in the fixture.
   *
   * Measured in scenario time, which only the caller moves: the reply stays
   * pending until the engine has been advanced this far past the call. It bounds
   * BOTH arms — a refusal a real transport takes 400 ms to deliver is a loading
   * state before it is an error, and a fixture that refused instantly would let a
   * surface ship without ever rendering that half.
   */
  readonly afterMs?: number;
}

/** A canned reply that answers with a value. */
export interface ScenarioResolvingReply extends ScenarioReplyBase {
  readonly result: unknown;
  readonly refusal?: never;
  readonly resultFor?: never;
}

/**
 * The refusal shape a scenario scripts: the wire envelope plus its structured context.
 *
 * `WireErrorEnvelope` is `{code, message}` and closes there, which is right for the
 * shape every renderer catch arm matches on and WRONG for what a daemon actually
 * sends on the refusals that name something: `pty.control_held_by_other` carries the
 * holder, and a rate-limited refusal carries its retry bound. `core/wire-rejection.ts`
 * reads both positions the corpus registers — `data.fields` on a JSON-RPC envelope and
 * `details` on a flat one — so a fixture that could only script `{code, message}` left
 * every extension-reading surface unreachable from any scenario.
 *
 * The member is OPTIONAL and typed as the flat position, so a scenario that scripts a
 * bare envelope is unchanged and one that scripts context reaches the same reader a
 * live rejection reaches. It is deliberately not a second extension vocabulary:
 * `core/refusal-extensions.ts` remains the one closed registry of what may be read
 * out of it, and a member no reader is registered for is simply not read.
 */
export type ScenarioRefusalEnvelope = WireErrorEnvelope & {
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * A canned reply that REFUSES, with the shape the wire refuses in.
 *
 * Without this arm no scenario could reach a refusal at all: the fixture's own
 * `FixtureBridgeError` names something the FIXTURE could not do, so every typed
 * daemon refusal a surface has to render — an artifact too large, an ingest at
 * capacity, a terminal permission denied, a control already held by someone else —
 * was unreachable, and the console's refusal renderings could only ever be driven
 * from the growth port's one typed absence.
 *
 * `WireErrorEnvelope` is not a second refusal vocabulary minted here. It is declared
 * in `src/shared/wire-errors.ts` and reached through `core/index.js`, which is the
 * console's one home for the wire's `{code, message}` shape and for
 * `normalizeWireRejection` — what every renderer catch arm already turns a rejection
 * into. `src/shared/` sits on no rung of the console's family DAG, so taking the
 * shape from `core` is what keeps one reading of it above that floor rather than one
 * per family. A fixture refusing in any other shape would train a surface against a
 * value the live bridge never sends.
 */
export interface ScenarioRejectingReply extends ScenarioReplyBase {
  readonly refusal: ScenarioRefusalEnvelope;
  readonly result?: never;
  readonly resultFor?: never;
}

/**
 * A canned reply the scenario COMPUTES from the request the caller actually sent.
 *
 * `replyFor` matches on the method NAME, which is right for a session-scoped read and
 * wrong for an entity-scoped one: a session holding two repo mounts asked
 * `repo.mountRead` twice and got the same mount back both times, so the second mount
 * and every state only it carried were unreachable — in the fixture and in every
 * capture taken from it — while the surfaces above read as though both had answered.
 *
 * Returning `undefined` means the scenario scripts no answer for THAT request and
 * settles exactly as an unscripted method does: refused by name, never resolved with
 * an absence, which renders as a claim about the session nothing checked.
 *
 * A COMPUTATION, NEVER A SECOND SCRIPT — no state, no mutation, called once per
 * settled reply, so a scenario stays replayable tick-for-tick on the frozen clock.
 * The request is typed `unknown` and is READ rather than destructured: this seam
 * reports settlements and throws none, so an exception raised in here leaves past
 * every refusal arm as itself.
 *
 * Which is also how a computed reply REFUSES. Returning `undefined` says the scenario
 * scripts no answer for that request, and settles as an unscripted call does; throwing
 * a `WireErrorEnvelope` says the daemon this scenario stands for would have refused,
 * and reaches the caller in exactly the shape the `refusal` arm reaches it in. The two
 * are different facts — an authoring gap and a scripted refusal — and a computed reply
 * that holds an entity table has both to report.
 *
 * AND IT IS HANDED THE INSTANT IT SETTLES AT, which is what lets a room answer a read
 * about a lifetime. A ledger row that expires forty seconds in was a fixed `pending`
 * for the life of the window: every re-read past the expiry answered the state the
 * scenario had at tick zero, so the one thing that room was written to show — an
 * invitation ageing out — was unreachable from it. The instant comes off the engine's
 * own frozen clock, so it is the SAME timeline the beats are due on rather than a
 * second one a reply could drift from, and a computation that ignores it settles
 * exactly where it always did.
 *
 * AND THE ORDINAL OF THIS ANSWER, which is what lets a room MINT. A reply that
 * answered a create call with one fixed receipt handed the same identity to every
 * caller: the second invitation a person sent arrived under the first one's id, so a
 * keyed ledger held two rows under one key, a list drew duplicate keys, and revoking
 * either moved both. The instant beside it cannot carry that — two calls parked on the
 * frozen clock together are released by one advance and read the same tick — so the
 * engine counts the answers it has produced for each call and hands the count in. The
 * reply stays a computation over what it is handed, which is what keeps the count off
 * the reply table and a playback replayable: the same calls in the same order are
 * handed the same ordinals.
 */
export interface ScenarioComputedReply extends ScenarioReplyBase {
  readonly resultFor: (
    request: unknown,
    settledAtMilliseconds: number,
    computedReplyOrdinal: number,
  ) => unknown;
  readonly result?: never;
  readonly refusal?: never;
}

/**
 * A canned reply for one request/response call the scenario expects.
 *
 * Exactly one of `result` / `refusal` / `resultFor`, enforced by the `?: never`
 * member on each arm rather than by independent optionals — the arm-union idiom the
 * corpus already uses for `AgentAttachRequest` in
 * `docs/architecture/contracts/api-payload-contracts.md`. Independent optionals would
 * admit two at once (a reply that resolves AND refuses) and none at all (a reply that
 * settles no way), which are the two shapes nothing can serve.
 */
export type ScenarioReply = ScenarioResolvingReply | ScenarioRejectingReply | ScenarioComputedReply;
