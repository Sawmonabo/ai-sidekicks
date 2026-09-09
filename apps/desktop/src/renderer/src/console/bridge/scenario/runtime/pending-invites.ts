// What a scenario states about the deep links arriving on THIS window's protocol
// handler: the invitations, the links whose preview could not be put, and the ones the
// control plane refused outright.
//
// ITS OWN MODULE, ON `scenario-engine.ts`'S SEAM APPLIED ONE LEVEL DOWN. `scenario.ts`
// says what a scenario IS; every other member it declares is a fact about the session
// on screen, and these three tables are the one family that is not — a deep link is an
// invitation to a DIFFERENT session, keyed by handles main mints and the renderer only
// carries. That family is also the one that grows: it is three tables now because the
// pending feed carries three states, and holding it here keeps the scenario shape a
// reader can still take in at a sitting.
//
// THREE TABLES AND NOT ONE UNION, because the three are keyed on three different
// things and a fixture that merged them would have to guess which kind a string names.
// An invitation is addressed by the reference its preview minted; a link that never
// reached the control plane minted none and is named by an opaque ATTEMPT handle; a
// REFUSED preview minted neither, and there is nothing to key it by at all. The last of
// those is why the refusals are a table rather than an arm of either neighbour: a
// keyless row in a table indexed by a handle has nowhere to sit.

import type {
  GrowthInviteAttempt,
  GrowthInviteOutcome,
  GrowthPendingInvite,
  GrowthPendingInviteRefused,
} from "../../growth-values/index.js";

/**
 * One invitation arriving on this window's deep link, and what confirming it does.
 *
 * THE OUTCOME IS SCRIPTED BESIDE THE INVITATION rather than in the reply table,
 * because it is the answer to an ACT and not to a read: nothing produces an outcome
 * until a person presses the one control that accepts, so a scenario states what
 * would happen if they did and the fixture holds it until they do.
 *
 * `onReconfirm` is separate and optional for the same reason its arm exists on the
 * wire: an acceptance that could not be PUT settles `unavailable`, which the wire
 * itself marks retryable, and the act that answers it is a second confirmation on
 * the same reference. A scenario that could state only one outcome per reference
 * could never show that recovery reach an end — and absent it, a second confirmation
 * finds nothing, which is the single-use posture and the ordinary case.
 *
 * IT IS NOT THE RETRY. A retry re-drives a PREVIEW on an attempt handle and is
 * scripted by {@link ScenarioPendingInviteAttemptFrame}, which mints invitations
 * rather than settling them.
 *
 * The invitation carries an opaque reference and no token, which is
 * `Plan-023 §Invariants` I-023-5 made unrepresentable: a fixture cannot script a raw
 * token onto this surface because the shape has nowhere to put one.
 */
export interface ScenarioPendingInviteFrame {
  readonly atMs: number;
  readonly invite: GrowthPendingInvite;
  readonly onConfirm: GrowthInviteOutcome;
  readonly onReconfirm?: GrowthInviteOutcome;
}

/**
 * The invitation a retry's preview produces, and how confirming that one settles.
 *
 * THE INVITATION FRAME WITHOUT ITS TICK, derived rather than restated, because the
 * tick is the retry itself: this arrives when a person presses, not when the clock
 * reaches a number, and a second `atMs` here would be a delivery moment nothing
 * consults. Everything else an invitation can script it scripts, `onReconfirm`
 * included — which is what lets one chain reach both handle-side outcome arms.
 */
export type ScenarioPendingInviteRetryResult = Omit<ScenarioPendingInviteFrame, "atMs">;

/**
 * One deep link whose preview could not be put at all, and what re-driving it yields.
 *
 * ITS OWN TABLE BECAUSE IT IS KEYED ON A DIFFERENT HANDLE. A pending invitation is
 * addressed by the reference its preview minted; a preview that never reached the
 * control plane minted none, and what names it is the opaque attempt handle the
 * `unavailable` arm carries. `Plan-023 §Phase 2 — IPC Bridge Registry And Per-Surface
 * Handlers` task T-023r-2-5 makes that a distinct brand accepted by no other
 * operation, so a fixture that indexed both in one table by one string would serve a
 * retry from whichever entry happened to collide — which is the defect this split
 * closes.
 */
export interface ScenarioPendingInviteAttemptFrame {
  readonly atMs: number;
  readonly attempt: GrowthInviteAttempt;
  /**
   * The preview state the retry publishes on the pending feed.
   *
   * The scripted answer to the one act this arm admits. A retry that produced
   * nothing observable would leave the surface holding a prompt it had already
   * released, so the fixture always publishes this and never an empty success.
   */
  readonly onRetry: ScenarioPendingInviteRetryResult;
}

/**
 * What the control plane SAID when it refused a preview: the code, and its sentence.
 *
 * The refused arm's own facts, taken off {@link GrowthPendingInviteRefused} rather
 * than respelled, so a scenario states the refusal in exactly the vocabulary the feed
 * carries it in — the wire's registered code, verbatim, and the wire's own sentence
 * beside it. The `status` discriminant is subtracted for the reason every other table
 * here subtracts one: the fixture stamps which arm a frame arrives on, in the one
 * place its due rule already decides that, so a scenario stays a table of refusals
 * rather than a table of wire states.
 */
export type ScenarioPendingInviteRefusal = Omit<GrowthPendingInviteRefused, "status">;

/**
 * One deep link the control plane answered with a typed refusal, and when it lands.
 *
 * THE TERMINAL ARM, AND THE ONE WITH NO HANDLE. An expired, revoked or already-consumed
 * link previews successfully as far as the transport is concerned and is REFUSED by the
 * control plane, so main mints no reference to confirm and no attempt handle to retry —
 * the person is owed the explanation and nothing else. Without this table the arm was
 * unreachable from any scenario: the two tables beside it build deliveries out of a
 * reference and an attempt, and a refusal has neither, so the console's terminal
 * rendering could be driven from no fixture at all.
 *
 * There is no `onConfirm` and there is nowhere to put one, which is the same property
 * `GrowthPendingInviteRefused` has: a refused preview admits no act, so a scenario that
 * could script an outcome for one would be scripting an answer to a question nobody can
 * ask.
 */
export interface ScenarioPendingInviteRefusedFrame {
  readonly atMs: number;
  readonly refusal: ScenarioPendingInviteRefusal;
}
