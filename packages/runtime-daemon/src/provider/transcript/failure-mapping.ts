// Permanent-vs-transient refusal classification (Plan-005 Phase 3, T3.22).
//
// `Spec-005 §Required Behavior` states the rule this module exists to enforce: a
// structurally invalid history is a PERMANENT refusal, never a retry. A poisoned
// history — an unpaired tool call, a reasoning item the target forbids — is
// rejected identically on every subsequent request, so a retry ladder over it
// buys nothing and spends a provider request per rung. The driver's answer is to
// classify the refusal permanent, dispose the run's provider binding, and let the
// caller reconstitute from the canonical transcript.
//
// The classifier owns BOTH arms of the distinction, and owning both is the point.
// A module that only recognized the permanent class would leave "everything else"
// as an implicit default nobody states, and the transient arm is precisely where
// the expensive mistake lives: retrying a request the provider may already have
// APPLIED repeats its spend and duplicates a turn the participant is watching. So
// the transient arm is narrowed here, in writing, to failures that are DEFINITELY
// UNSENT, and the outcome a connection loss left unknown gets its own arm with
// its own evidence requirement.
//
// Spec coverage: `Spec-005 §Required Behavior` (a structurally invalid history is
// a permanent refusal, never a retry); `Spec-005 §Fallback Behavior`.
// Verifies invariant I-005-9.
//
// Driver-agnostic on purpose, for the reason the sibling assertion module is:
// both legs refuse over different transports and both owe the identical verdict,
// so the rules live once, here, and each driver supplies only a NORMALIZED
// observation of what its own transport saw. A driver that owned its own verdict
// could weaken it without the weakening being visible in one place.
//
// What this module deliberately does NOT do:
//
//   * It never reads a provider message string. `Spec-005 §Pitfalls To Avoid`
//     prohibits classifying a refusal by matching its text, and a classifier that
//     accepted prose would make every provider wording change a silent behaviour
//     change. The permanent arm is reachable only from a TYPED refusal shape the
//     driver derived from the provider's own enumerated refusal vocabulary.
//   * It never produces a `RecoveryCondition`. That taxonomy (T3.14) describes
//     what a RESUME needs; a permanent structural refusal describes a history the
//     target will never accept, and absorbing it into `recovery-needed` would send
//     the daemon to re-establish a session whose next request refuses identically.
//     The two vocabularies stay separate by construction: nothing here imports
//     that type, and the permanent arm's carrier is this module's own error class.
//   * It never re-enters a replay. Mid-replay ambiguity and replay-interior
//     refusals are T3.20's target-lifecycle rules (`./replay-assertion.ts`) and
//     settle on T3.21's memo floor (`./memo-projection.ts`). The "exactly one
//     reconstitution" property is kept STRUCTURALLY rather than by a counter: the
//     ladder below is absent from the replay path, so there is no rung a replay
//     could climb.

// --------------------------------------------------------------------------
// What the driver observed
// --------------------------------------------------------------------------

/**
 * How far a failed request's bytes got, as the driver's transport can place them.
 *
 * The three-value shape is the intersection of the two shipped driver
 * vocabularies rather than a fourth invention. Codex's request seam reports
 * `unsent | refused | indeterminate`; Claude's user-text write reports
 * `unsent | indeterminate` and deliberately carries no refused arm, because a
 * user-text write there is one-way stdin and the provider answers a TURN rather
 * than the write. Normalizing to a shared vocabulary is what lets one classifier
 * rule for both legs; naming the refused arm `consumed-and-refused` rather than
 * `refused` keeps the load-bearing half of the claim — that the provider
 * PROCESSED the request — in the identifier where a reader cannot miss it.
 *
 *   * `unsent` — a POSITIVE claim about bytes: the failure landed wholly ahead of
 *     the first one. The provider saw nothing, so no turn exists on account of
 *     this request and none ever will. This is the only class a retry may re-send
 *     without evidence, because there is nothing to duplicate.
 *   * `consumed-and-refused` — the provider read the request and answered "no".
 *     An answer is proof it processed the request and started nothing, which is
 *     what makes this class safe to reason about at all — and it is the ONLY class
 *     that can carry a typed refusal shape, since a refusal shape is something the
 *     provider said.
 *   * `indeterminate` — anything at or after the hand-off, and anything the
 *     transport cannot place ahead of it. Whether the provider applied the request
 *     is not knowable from the failure, so this class is never retried on the
 *     strength of the failure alone.
 */
export type ProviderRequestDeliveryClass = "unsent" | "consumed-and-refused" | "indeterminate";

/**
 * The provider's own typed refusal, reduced to the distinction this module rules
 * on.
 *
 * A closed two-member union rather than a pass-through of each provider's enum,
 * because the question asked here is binary — is the HISTORY the thing being
 * refused? — and a wider type would invite a call site to branch on a provider
 * detail this module has no rule for. Each driver maps its own enumerated
 * vocabulary onto these two members at its dispatch seam, which is the only place
 * that knows the provider's shapes.
 *
 *   * `history-structurally-invalid` — the refusal names the conversation state
 *     itself: an unpaired tool call, a rejected reasoning item, a history the
 *     target's deserializer will not accept. Permanent by definition — the same
 *     history is sent again on every subsequent request, so the same refusal comes
 *     back.
 *   * `request-otherwise-refused` — the provider declined THIS request for a
 *     reason that is not the history. A rate ceiling, an unsupported parameter, a
 *     malformed field the caller can correct. Not permanent in the structural
 *     sense, and equally not retryable here: the provider already consumed the
 *     request, so re-sending it repeats whatever it did with it.
 */
export type ProviderRefusalShape = "history-structurally-invalid" | "request-otherwise-refused";

/**
 * One failed provider request, normalized for classification.
 *
 * `refusalShape` is meaningful on exactly one delivery class and is DISREGARDED
 * on the other two rather than rejected. A driver cannot have read a typed refusal
 * from a request the provider never saw, or from one whose answer never arrived;
 * making the combination unrepresentable would cost a discriminated union per call
 * site, while disregarding it keeps the classification total. The disregarded
 * value is reported back on {@link ProviderRequestFailureClassification} so a
 * driver that wired it wrongly is caught by a test rather than by a silently wrong
 * production route.
 */
export interface ProviderRequestFailureObservation {
  readonly delivery: ProviderRequestDeliveryClass;
  readonly refusalShape?: ProviderRefusalShape | undefined;
}

// --------------------------------------------------------------------------
// The verdict
// --------------------------------------------------------------------------

/**
 * What the driver must do with a failed request. Four arms, closed, exhaustive.
 *
 *   * `permanent-structural-refusal` — dispose the run's provider binding and let
 *     the caller reconstitute from the canonical transcript. NEVER a rung on a
 *     ladder: the assertion that proves this is a call count, because the defect
 *     being prevented is expenditure.
 *   * `retry-definitely-unsent` — the only arm that may re-send without first
 *     reading the target back, and only because there is provably nothing at the
 *     target to duplicate.
 *   * `reconcile-ambiguous-delivery` — the request may or may not have been
 *     applied. Nothing is re-sent and nothing is assumed until the target has been
 *     read back positionally; see {@link AmbiguousDeliveryReconciler}.
 *   * `fail-consumed-and-declined` — the provider processed the request and
 *     declined it for a reason that is not the history. Reported on the run's
 *     existing failure path, unchanged. This arm exists so the other three can be
 *     narrow: without it a non-structural refusal would have to be forced into one
 *     of them, and every candidate is wrong — retrying repeats a consumed request,
 *     reconciling reads a target for an answer the provider already gave, and
 *     reconstituting rebuilds a history that was never the problem.
 */
export type ProviderRequestFailureDisposition =
  | "permanent-structural-refusal"
  | "retry-definitely-unsent"
  | "reconcile-ambiguous-delivery"
  | "fail-consumed-and-declined";

/**
 * The verdict, plus what was disregarded reaching it.
 *
 * `disregardedRefusalShape` is populated only where the observation carried a
 * refusal shape the delivery class made meaningless. It is diagnostic rather than
 * normative — no branch reads it — and it exists because a driver that reports a
 * typed refusal beside `unsent` or `indeterminate` has a wiring bug whose only
 * other symptom is a silently wrong route.
 */
export interface ProviderRequestFailureClassification {
  readonly disposition: ProviderRequestFailureDisposition;
  readonly disregardedRefusalShape?: ProviderRefusalShape | undefined;
}

/**
 * The whole rule, in one total function over the observation.
 *
 * Pure and free of transport, so both legs' wiring is a mapping problem rather
 * than a policy problem: a driver decides what its transport SAW, never what the
 * daemon should do about it. That split is what makes the two drivers provably
 * consistent — there is one table, and it is this one.
 */
export function classifyProviderRequestFailure(
  observation: ProviderRequestFailureObservation,
): ProviderRequestFailureClassification {
  if (observation.delivery === "consumed-and-refused") {
    // An ABSENT shape on a refusal is not read as structural. The permanent arm
    // disposes a binding and forces a reconstitution, so it is reached only on a
    // positive typed claim by the provider; a driver that cannot type its
    // provider's refusals lands on the declined arm, which changes nothing about
    // today's behaviour. Fail-closed here means declining to escalate.
    return observation.refusalShape === "history-structurally-invalid"
      ? { disposition: "permanent-structural-refusal" }
      : { disposition: "fail-consumed-and-declined" };
  }
  const disposition: ProviderRequestFailureDisposition =
    observation.delivery === "unsent" ? "retry-definitely-unsent" : "reconcile-ambiguous-delivery";
  return observation.refusalShape === undefined
    ? { disposition }
    : { disposition, disregardedRefusalShape: observation.refusalShape };
}

/**
 * The permanent refusal, as it crosses the driver boundary.
 *
 * A dedicated class rather than a flag on an existing transport error, because
 * the caller's response is categorically different: every other failure here says
 * "this request did not work", and this one says "this provider session can never
 * accept this history again". A caller that could not tell them apart would retry
 * the run onto the same poisoned session forever.
 *
 * Deliberately NOT a `RecoveryCondition`, and deliberately not convertible to
 * one. `Spec-005 §Required Behavior` keeps the classes distinct, and the
 * distinction is operational rather than taxonomic: `recovery-needed` sends the
 * daemon to re-establish the session, which reproduces this refusal on the first
 * request against the rebuilt history. What this failure asks for is a
 * RECONSTITUTION — a canonical-transcript replay into a fresh target — which is a
 * different act by a different owner.
 */
export class PermanentStructuralRefusalError extends Error {
  readonly providerSessionId: string;
  readonly runId: string | undefined;
  /** Always the structural member; carried so a log line names the evidence. */
  readonly refusalShape = "history-structurally-invalid" as const;
  /**
   * The standing obligation this failure places on its caller: reconstitute from
   * the canonical transcript. A literal rather than a computed value — no
   * reachable construction of this error fails to owe it — so the property reads
   * as documentation the type system holds, and an arm that did NOT owe
   * reconstitution could not be added without the constructor changing.
   */
  readonly reconstitutionRequired = true as const;

  constructor(details: {
    readonly providerSessionId: string;
    readonly runId?: string | undefined;
    readonly cause?: unknown;
  }) {
    super(
      `The provider refused the request because the session history is structurally invalid; provider session "${details.providerSessionId}" must be reconstituted rather than retried.`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "PermanentStructuralRefusalError";
    this.providerSessionId = details.providerSessionId;
    this.runId = details.runId;
  }
}

// --------------------------------------------------------------------------
// The positional reconcile
// --------------------------------------------------------------------------

/**
 * How many PARTICIPANT-ORIGINATED turns the target holds.
 *
 * The role dimension is what distinguishes this port from the two readback ports
 * already shipped beside it. `ReplayTargetReadback` (`./replay-assertion.ts`) and
 * `MemoTargetGateway.readTurnsForMarkerReconciliation` (`./memo-projection.ts`)
 * both answer with turn BODIES as text, which is the right shape for their
 * questions — one compares a tail, the other looks for a marker it carried — and
 * is not a shape this question can be asked in: a body-only answer interleaves
 * assistant turns the daemon's acknowledged set does not hold, so counting it
 * compares two different units.
 *
 * So this is the SAME provider question with the dimension the count needs, not a
 * second notion of what a target holds. It is deliberately a sibling port rather
 * than a widening of either shipped one: widening would ripple into the tail
 * comparison and the marker scan, neither of which has a use for roles, and would
 * make every existing binding restate a dimension it does not read.
 *
 * A leg that binds no reader answers `unreadable`, and that is a CORRECT
 * SETTLEMENT rather than a gap to be repaired later: `Spec-005 §Fallback Behavior`
 * and the reconcile rule both specify the unreadable target as a first-class arm —
 * nothing is sent and the turn fails visibly. An unbound reader therefore behaves
 * exactly as a reader that answered "I cannot tell you", which is the honest
 * answer when no provider surface can supply the count.
 */
export type ParticipantTurnReadback =
  | { readonly kind: "counted"; readonly participantOriginatedTurns: number }
  | { readonly kind: "unreadable"; readonly reason: string };

/** Reads {@link ParticipantTurnReadback} for one provider session. */
export type ParticipantTurnReadbackReader = (
  targetProviderSessionId: string,
) => Promise<ParticipantTurnReadback>;

/**
 * What the positional read settled about an ambiguous request.
 *
 *   * `delivered` — the target holds more participant turns than the daemon has
 *     acknowledged, so the ambiguous request landed. Nothing is re-sent. The
 *     request still FAILS at the driver boundary: the acknowledgement carried the
 *     turn's identity, so a turn that landed without one is unaddressable, and
 *     reporting the run started would strand a route no interrupt can reach. What
 *     this settlement buys is the absence of a duplicate, not a rescued turn.
 *   * `cleared-for-retry` — the count does not include the ambiguous request, so
 *     it did not land and re-sending duplicates nothing.
 *   * `unrecoverable` — the target could not be read. Neither silent option is
 *     admissible: re-sending risks duplicate spend against a turn that landed, and
 *     assuming delivery suppresses a request the participant made. The turn fails
 *     visibly instead.
 */
export type AmbiguousDeliverySettlement =
  | { readonly settlement: "delivered"; readonly participantOriginatedTurns: number }
  | { readonly settlement: "cleared-for-retry"; readonly participantOriginatedTurns: number }
  | { readonly settlement: "unrecoverable"; readonly reason: string };

/** The reason reported when a leg binds no participant-turn reader at all. */
export const NO_PARTICIPANT_TURN_READER_BOUND: string =
  "This driver binds no participant-turn readback for the target session.";

/** The reason reported when the bound reader itself failed to answer. */
export const PARTICIPANT_TURN_READ_FAILED: string =
  "The participant-turn readback for the target session did not answer.";

/**
 * Reconciles an ambiguous delivery positionally, and holds the send window open
 * around the caller's response to it.
 *
 * POSITIONAL, NEVER CONTENT-BASED. An ordinary turn carries no identity marker —
 * that carriage is T3.21's memo mechanism, minted for exactly this problem on a
 * path that could afford it — and participant text may legitimately repeat, so
 * matching bodies would settle a participant who asked the same question twice as
 * a duplicate. Counting is the one comparison both sides can perform on the same
 * unit.
 *
 * RECONCILE BEFORE SEND, and the ordering is enforced here rather than asked of
 * the caller. {@link AmbiguousDeliveryReconciler.reconcileThenAct} runs the read
 * and the caller's response to it inside one per-target critical section, so no
 * concurrent RECONCILE of the same provider session can move either count between
 * the read and the act. That matters unevenly across the two legs and is therefore
 * not left to either: one shipped leg already serializes turn dispatch per session
 * and the other explicitly does not, so a guarantee resting on the driver would
 * hold on one side and silently fail on the other.
 *
 * Two windows stay open, and both are stated rather than overclaimed away. A send
 * that never enters this section — an ordinary ACCEPTED dispatch on the same
 * target — is outside the guarantee and can move the target's count after the
 * caller captured its acknowledged one. A request whose bytes are still being
 * processed provider-side can likewise be absent from a count taken a moment
 * later, no matter what the daemon serializes.
 *
 * The two skew in opposite directions, and only one of them is harmless. The
 * first can only INFLATE what the target reports, so the worst it reaches is
 * `delivered` — the conservative arm, which disposes and re-sends nothing. The
 * second can DEFLATE it, and that one is a real limit rather than a harmless one:
 * a turn still being processed can be missing from the count, settle
 * `cleared-for-retry`, and then appear — so a caller that re-dispatches on that
 * settlement can duplicate it. That is the inherent cost of a marker-free
 * reconcile, stated here rather than argued away, and it is why the memo path
 * carries a marker instead. What bounds it is that nothing on this leg re-sends:
 * `cleared-for-retry` clears a caller to re-dispatch, the run fails visibly
 * first, and every unknown that remains resolves the way every other one does, by
 * the count the target answered with at the moment it was asked.
 */
export class AmbiguousDeliveryReconciler {
  readonly #readParticipantTurns: ParticipantTurnReadbackReader | undefined;
  /**
   * The TAIL of each target's reconcile queue, keyed by provider session id.
   *
   * Target-scoped rather than request-scoped for the reason the memo
   * coordinator's queue is: the fact being protected is a property of the
   * conversation — how many participant turns it holds — so two reconciles against
   * one target must not interleave, while reconciles against different targets
   * have nothing to say to each other and must not queue behind one another.
   */
  readonly #reconcileQueueTails: Map<string, Promise<unknown>> = new Map();

  constructor(readParticipantTurns?: ParticipantTurnReadbackReader | undefined) {
    this.#readParticipantTurns = readParticipantTurns;
  }

  /** Whether this reconciler can read a target back at all. */
  get canReadParticipantTurns(): boolean {
    return this.#readParticipantTurns !== undefined;
  }

  /**
   * Reads the target back, settles the ambiguity, and hands the settlement to
   * `act` — all inside this target's critical section.
   *
   * `act` is invoked INSIDE the section rather than after it, because the send it
   * may perform is the very thing the read was taken to authorize. Returning the
   * settlement and trusting the caller to act promptly would reopen precisely the
   * window this class exists to close.
   *
   * `acknowledgedParticipantSends` is the count the daemon has ACKNOWLEDGED — the
   * ambiguous request itself is excluded, because it is the thing being ruled on.
   * A target holding more than that has the ambiguous turn in it.
   */
  async reconcileThenAct<T>(
    request: {
      readonly targetProviderSessionId: string;
      readonly acknowledgedParticipantSends: number;
    },
    act: (settlement: AmbiguousDeliverySettlement) => Promise<T>,
  ): Promise<T> {
    const predecessor = this.#reconcileQueueTails.get(request.targetProviderSessionId);
    // Chained off whatever is already running for this target, and off its FAILURE
    // too: a reconcile that threw still released the target, and queueing the next
    // one behind a rejected promise would reject it for someone else's reason. The
    // predecessor is awaited for its ORDERING, never for its value.
    const settled: Promise<T> = (predecessor ?? Promise.resolve()).then(
      async () => await act(await this.#readAndSettle(request)),
      async () => await act(await this.#readAndSettle(request)),
    );
    // The queue copy swallows rejection so an unhandled one cannot escape from the
    // entry a later caller chains onto; the copy returned below keeps its
    // rejection intact.
    const queued: Promise<unknown> = settled.catch(() => undefined);
    this.#reconcileQueueTails.set(request.targetProviderSessionId, queued);
    try {
      return await settled;
    } finally {
      // Identity-gated. A later caller has already replaced the tail with its own
      // promise, and deleting unconditionally would drop ITS ordering guarantee —
      // the next arrival would chain off nothing and run concurrently with it.
      if (this.#reconcileQueueTails.get(request.targetProviderSessionId) === queued) {
        this.#reconcileQueueTails.delete(request.targetProviderSessionId);
      }
    }
  }

  async #readAndSettle(request: {
    readonly targetProviderSessionId: string;
    readonly acknowledgedParticipantSends: number;
  }): Promise<AmbiguousDeliverySettlement> {
    const readParticipantTurns = this.#readParticipantTurns;
    if (readParticipantTurns === undefined) {
      return { settlement: "unrecoverable", reason: NO_PARTICIPANT_TURN_READER_BOUND };
    }
    let readback: ParticipantTurnReadback;
    try {
      readback = await readParticipantTurns(request.targetProviderSessionId);
    } catch {
      // A throwing reader is an unreadable target, not a crash to propagate. The
      // caller is in the middle of settling a turn; converting its ambiguity into
      // a different exception would replace a settlement it can report with one it
      // cannot classify.
      return { settlement: "unrecoverable", reason: PARTICIPANT_TURN_READ_FAILED };
    }
    if (readback.kind === "unreadable") {
      return { settlement: "unrecoverable", reason: readback.reason };
    }
    // STRICTLY GREATER, and the direction is the whole rule. The acknowledged
    // count excludes the ambiguous request, so a target holding more turns than
    // that holds this one. Equality means the target holds exactly what the daemon
    // already knows about — the request did not land. A target holding FEWER turns
    // than acknowledged is a disagreement about history rather than about this
    // request, and it lands on the same arm as equality for the reason that arm
    // exists: nothing there proves the ambiguous turn landed, so nothing is
    // suppressed on that basis.
    return readback.participantOriginatedTurns > request.acknowledgedParticipantSends
      ? { settlement: "delivered", participantOriginatedTurns: readback.participantOriginatedTurns }
      : {
          settlement: "cleared-for-retry",
          participantOriginatedTurns: readback.participantOriginatedTurns,
        };
  }
}

// --------------------------------------------------------------------------
// The ladder — and where it deliberately is not
// --------------------------------------------------------------------------

/**
 * How many dispatch attempts one request may cost, INCLUDING the first.
 *
 * Two, not a configurable ceiling. The transient arm exists to survive a fault
 * that left the provider untouched, and a second attempt against a live transport
 * either works or fails the same way — a third rung buys retries of a condition
 * the second attempt already characterized, at one provider request each. Naming
 * it as a constant rather than inlining `2` is what lets the exactly-one-attempt
 * property of the permanent arm be stated as "the ladder is never entered" rather
 * than as a number a reader has to compare against.
 */
export const MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS: number = 2;

/**
 * Whether a definitely-unsent failure may be re-sent, given attempts already made.
 *
 * Takes the count rather than owning a counter, so the ladder holds no state: each
 * driver already counts the attempts of the dispatch it is running, and a second,
 * module-held counter would be a second record of the same fact — reachable from a
 * path that forgot to reset it.
 */
export function mayReattemptAfterDefinitelyUnsent(attemptsAlreadyMade: number): boolean {
  return attemptsAlreadyMade < MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS;
}
