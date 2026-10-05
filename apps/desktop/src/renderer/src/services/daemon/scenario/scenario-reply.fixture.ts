// The reply table a scenario scripts: what a request/response call is answered with. It is split
// from the scenario (`fixtures/scenario.ts`) because it answers a question about a single call,
// which arm it takes, what a computed one is handed and what shape a refusal arrives in, so
// `scripted/reply.fixture.ts` and the scenario contract reply checks in
// `tests/helpers/scenario-contract-check/reply-checks.ts` need no other scenario member.

import type { WireErrorEnvelope } from "#renderer/lib/wire/errors.js";
import type { MachineNoticeStreamName } from "../session/event/session-event-streams.js";

/**
 * A stamp a request carries, as epoch milliseconds, read through the app's one instant reader,
 * so a scenario compares it with its own instants without parsing text. A stamp that is not a UTC
 * instant is a fixture fault and throws.
 */
export type RequestStampReader = (stamp: string) => number;

/** A canned reply that answers with a value. */
export interface ScenarioResolvingReply extends ScenarioReplyBase {
  readonly result: unknown;
  readonly refusal?: never;
  readonly resultFor?: never;
}

/**
 * The refusal shape a scenario scripts: the wire envelope plus its structured context.
 *
 * `{code, message}` alone cannot script the refusals that name something, such as
 * `pty.control_held_by_other` (the holder) or a rate-limited refusal (its retry bound).
 * `lib/wire/rejection.ts` reads `data.fields` on a JSON-RPC envelope and `details` on a flat one;
 * the optional `details` member reaches the same reader a live rejection does. It is not a second
 * extension vocabulary: `lib/refusal/refusal-extensions.ts` stays the one registry of what may be
 * read.
 */
export type ScenarioRefusalEnvelope = WireErrorEnvelope & {
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * A canned reply that refuses, in the shape the wire refuses in. Without this arm no typed daemon
 * refusal a view renders would be reachable, since `FixtureBridgeError` names only what the
 * fixture could not do. The shape is `WireErrorEnvelope` from `lib/wire/errors.ts`, the
 * app's one reading of it; any other shape would train a view against a value the live bridge
 * never sends.
 */
export interface ScenarioRejectingReply extends ScenarioReplyBase {
  readonly refusal: ScenarioRefusalEnvelope;
  readonly result?: never;
  readonly resultFor?: never;
}

/**
 * A canned reply the scenario computes from the request the caller actually sent. A method-name
 * match is wrong for an entity-scoped read: two repo mounts read with `repo.mountRead` would get
 * the same mount back.
 *
 * It is a computation, never a second script: no state of its own, no mutation, called once per
 * settled reply, so a playback is replayable tick for tick. The request is `unknown` and read, not
 * destructured, and this seam throws nothing of its own. Returning `undefined` settles as an
 * unscripted method does (refused by name, never resolved with an absence); throwing a
 * `WireErrorEnvelope` is a scripted daemon refusal, reaching the caller as the `refusal` arm does.
 *
 * It is handed the instant it settles at, from the engine's frozen clock, so a read about a
 * lifetime (a transcript row expiring forty seconds in) can change with time. It is also handed the
 * ordinal of this answer, counted per call by the engine, so a create call mints a distinct
 * identity each time; an instant cannot, since two parked calls released by one advance read the
 * same tick. And it is handed the requests the playback has already answered for any write, held
 * by the engine, so a read reflects a write the daemon would have applied: a switched-off binding
 * reads back switched off. A stamp the request carries is read through `readRequestStamp`.
 */
export interface ScenarioComputedReply extends ScenarioReplyBase {
  readonly resultFor: (
    request: unknown,
    settledAtMilliseconds: number,
    computedReplyOrdinal: number,
    answeredRequestsFor: (call: string) => readonly unknown[],
    readRequestStamp: RequestStampReader,
  ) => unknown;
  readonly result?: never;
  readonly refusal?: never;
}

/**
 * A canned reply for one request/response call the scenario expects. Exactly one of `result`,
 * `refusal` or `resultFor`, enforced by `?: never` on each arm, since independent optionals would
 * admit a reply that both resolves and refuses, or neither.
 */
export type ScenarioReply = ScenarioResolvingReply | ScenarioRejectingReply | ScenarioComputedReply;

/**
 * One live notice a settled reply pushes on a machine stream, as the daemon pushes one after an
 * edit or when a sign-in it brokered finishes. The payload is composed when the notice comes due,
 * from the writes the playback has answered by then, so a later write can withdraw it: a sign-in
 * canceled before it finishes reports no completion. It is held to the stream's registered
 * emission shape as it is delivered.
 */
export interface ScenarioNotice {
  readonly stream: MachineNoticeStreamName;
  /** Scenario time after the reply settles; zero pushes it at once. */
  readonly afterMs: number;
  /** The frame to push, or `undefined` when a write since the reply means there is none. */
  readonly payloadAtDelivery: (
    answeredRequestsFor: (call: string) => readonly unknown[],
    readRequestStamp: RequestStampReader,
  ) => unknown;
}

/**
 * The frame a machine stream sends first, the moment it is opened, as `workflow.subscribe` sends
 * the current start hold before anything else. Composed when the subscriber opens the stream,
 * from the writes the playback has answered by then, so a hold switched on earlier opens on.
 */
export interface ScenarioOpeningNotice {
  readonly stream: MachineNoticeStreamName;
  readonly payloadAtOpen: (
    answeredRequestsFor: (call: string) => readonly unknown[],
    readRequestStamp: RequestStampReader,
  ) => unknown;
}

/** What every canned reply carries, whichever way it settles. */
interface ScenarioReplyBase {
  /** The daemon method name, verbatim. */
  readonly call: string;
  /**
   * Simulated latency, so a loading state is reachable. Measured in scenario time, which only
   * the caller moves: the reply stays pending until the engine has advanced this far past the
   * call. It applies to refusals too, since a refusal is a loading state before it is an error.
   */
  readonly afterMs?: number;
  /**
   * The notices a resolved answer pushes, computed from the request and the answer so a notice
   * names the binding, account or attempt they name. A refused or unscripted answer pushes none.
   */
  readonly noticesFor?: (request: unknown, answer: unknown) => readonly ScenarioNotice[];
}
