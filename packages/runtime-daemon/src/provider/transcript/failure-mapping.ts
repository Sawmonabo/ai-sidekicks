// Permanent-vs-transient classification of a failed provider request.
// - A structurally invalid history (an unpaired tool call, a reasoning item the target forbids) is
//   refused identically on every request: permanent, never retried. The driver disposes the run's
//   provider binding and the session falls back to the hand-over brief.
// - The transient arm covers only definitely-unsent failures: retrying a request the provider may
//   have applied repeats its spend and duplicates a turn, so an unknown outcome has its own arm.
// - The rules live here once; each driver supplies only a normalized observation of its transport.
// - No provider message text is read: the permanent arm needs a typed refusal shape derived from
//   the provider's own enumerated refusal vocabulary.
// - No `RecoveryCondition` is produced: resuming would re-establish a session whose next request
//   refuses identically. An ambiguous hand-over send is reconciled in `./memo-delivery.ts`.

/**
 * How far a failed request's bytes got, as the transport can place them. `unsent` is a positive
 * claim that the failure landed ahead of the first byte; only `consumed-and-refused` can carry a
 * refusal shape (Claude never reports it: its user-text write is one-way stdin and the provider
 * answers a turn, not the write); `indeterminate` alone never justifies a retry.
 */
export type ProviderRequestDeliveryClass = "unsent" | "consumed-and-refused" | "indeterminate";

/**
 * The provider's typed refusal reduced to one question: is the history what is refused? Each
 * driver maps its enumerated refusal vocabulary onto these members; `request-otherwise-refused`
 * is not retryable either, since the provider consumed the request.
 */
export type ProviderRefusalShape = "history-structurally-invalid" | "request-otherwise-refused";

/**
 * One failed provider request, normalized. `refusalShape` counts only on `consumed-and-refused`;
 * elsewhere it is disregarded, not rejected, and reported so a miswired driver shows in a test.
 */
export interface ProviderRequestFailureObservation {
  readonly delivery: ProviderRequestDeliveryClass;
  readonly refusalShape?: ProviderRefusalShape | undefined;
}

/**
 * What the driver must do with a failed request. Only `retry-definitely-unsent` may re-send
 * without reading the target back; `reconcile-ambiguous-delivery` re-sends nothing until it has
 * (see {@link AmbiguousDeliveryReconciler}).
 */
export type ProviderRequestFailureDisposition =
  | "permanent-structural-refusal"
  | "retry-definitely-unsent"
  | "reconcile-ambiguous-delivery"
  | "fail-consumed-and-declined";

/** The verdict, plus the refusal shape disregarded in reaching it; no branch reads that field. */
export interface ProviderRequestFailureClassification {
  readonly disposition: ProviderRequestFailureDisposition;
  readonly disregardedRefusalShape?: ProviderRefusalShape | undefined;
}

/** The whole classification rule, a pure total function over the observation. */
export function classifyProviderRequestFailure(
  observation: ProviderRequestFailureObservation,
): ProviderRequestFailureClassification {
  if (observation.delivery === "consumed-and-refused") {
    // An absent shape is not read as structural: the permanent arm forces a fresh session from the
    // hand-over brief, so it needs a positive typed claim.
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
 * The permanent refusal as it crosses the driver boundary. A class, not a flag, so a caller cannot
 * mistake it for an ordinary failure and retry onto the same session; it needs a fresh session from
 * the hand-over brief, not a `RecoveryCondition`'s session re-establishment, which would refuse
 * identically.
 */
export class PermanentStructuralRefusalError extends Error {
  readonly providerSessionId: string;
  readonly runId: string | undefined;
  /** Always the structural member; carried so a log line names the evidence. */
  readonly refusalShape = "history-structurally-invalid" as const;
  /** The caller's standing obligation; a literal type because every construction owes it. */
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

/**
 * How many user-originated turns the target holds. Not the body list of
 * `MemoTargetGateway.readTurnsForMarkerReconciliation`: it interleaves assistant turns the
 * acknowledged count does not hold, so counting them compares different units.
 */
export type UserTurnReadback =
  | { readonly kind: "counted"; readonly userOriginatedTurns: number }
  | { readonly kind: "unreadable"; readonly reason: string };

/** Reads {@link UserTurnReadback} for one provider session. */
export type UserTurnReadbackReader = (targetProviderSessionId: string) => Promise<UserTurnReadback>;

/**
 * What the positional read settled about an ambiguous request. `delivered` still fails the
 * request at the driver boundary (a turn that landed without its acknowledgement is
 * unaddressable); it only avoids a duplicate. `unrecoverable` fails visibly rather than guess.
 */
export type AmbiguousDeliverySettlement =
  | { readonly settlement: "delivered"; readonly userOriginatedTurns: number }
  | { readonly settlement: "cleared-for-retry"; readonly userOriginatedTurns: number }
  | { readonly settlement: "unrecoverable"; readonly reason: string };

/** The reason reported when a leg binds no user-turn reader at all. */
export const NO_USER_TURN_READER_BOUND: string =
  "This driver binds no user-turn readback for the target session.";

/** The reason reported when the bound reader itself failed to answer. */
export const USER_TURN_READ_FAILED: string =
  "The user-turn readback for the target session did not answer.";

/**
 * Reconciles an ambiguous delivery by counting the target's user-originated turns inside a
 * per-target critical section around the caller's response, so no concurrent reconcile can move
 * the count in between. Counting, not body matching, since user text may repeat.
 */
export class AmbiguousDeliveryReconciler {
  readonly #readUserTurns: UserTurnReadbackReader | undefined;
  // Per-target queue tails: same-target reconciles must not interleave, other targets must not
  // wait.
  readonly #reconcileQueueTails: Map<string, Promise<unknown>> = new Map();

  constructor(readUserTurns?: UserTurnReadbackReader | undefined) {
    this.#readUserTurns = readUserTurns;
  }

  /** Whether this reconciler can read a target back at all. */
  get canReadUserTurns(): boolean {
    return this.#readUserTurns !== undefined;
  }

  /**
   * Reads the target back and hands the settlement to `act`, inside this target's critical section
   * because the send `act` may perform is what the read authorizes. `acknowledgedUserSends`
   * excludes the ambiguous request itself.
   */
  async reconcileThenAct<T>(
    request: {
      readonly targetProviderSessionId: string;
      readonly acknowledgedUserSends: number;
    },
    act: (settlement: AmbiguousDeliverySettlement) => Promise<T>,
  ): Promise<T> {
    // Two windows stay open: an ordinary dispatch on the target skips this section and can only
    // push the result to `delivered`; a request still in flight provider-side may settle
    // `cleared-for-retry` and then appear, a duplicate only the memo path's marker avoids.
    const predecessor = this.#reconcileQueueTails.get(request.targetProviderSessionId);
    // Chained off the predecessor whether it succeeded or failed; only its ordering is awaited.
    const settled: Promise<T> = (predecessor ?? Promise.resolve()).then(
      async () => await act(await this.#readAndSettle(request)),
      async () => await act(await this.#readAndSettle(request)),
    );
    // The queued copy swallows rejection so it cannot surface as unhandled for a later chained
    // caller.
    const queued: Promise<unknown> = settled.catch(() => undefined);
    this.#reconcileQueueTails.set(request.targetProviderSessionId, queued);
    try {
      return await settled;
    } finally {
      // Only the current tail is deleted; a later caller has replaced it otherwise.
      if (this.#reconcileQueueTails.get(request.targetProviderSessionId) === queued) {
        this.#reconcileQueueTails.delete(request.targetProviderSessionId);
      }
    }
  }

  async #readAndSettle(request: {
    readonly targetProviderSessionId: string;
    readonly acknowledgedUserSends: number;
  }): Promise<AmbiguousDeliverySettlement> {
    const readUserTurns = this.#readUserTurns;
    if (readUserTurns === undefined) {
      return { settlement: "unrecoverable", reason: NO_USER_TURN_READER_BOUND };
    }
    let readback: UserTurnReadback;
    try {
      readback = await readUserTurns(request.targetProviderSessionId);
    } catch {
      // A throwing reader is an unreadable target; the caller needs a settlement, not an exception.
      return { settlement: "unrecoverable", reason: USER_TURN_READ_FAILED };
    }
    if (readback.kind === "unreadable") {
      return { settlement: "unrecoverable", reason: readback.reason };
    }
    // Strictly greater: the acknowledged count excludes the ambiguous request, so more turns means
    // it landed. Fewer is a disagreement about history, not this request, so it takes the equal arm
    // and suppresses nothing.
    return readback.userOriginatedTurns > request.acknowledgedUserSends
      ? { settlement: "delivered", userOriginatedTurns: readback.userOriginatedTurns }
      : {
          settlement: "cleared-for-retry",
          userOriginatedTurns: readback.userOriginatedTurns,
        };
  }
}

/**
 * How many dispatch attempts one request may cost, including the first: a second either works or
 * fails the same way, and each further rung costs a provider request.
 */
export const MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS: number = 2;

/**
 * Whether a definitely-unsent failure may be re-sent, given the attempts already made. It takes
 * the count so no module-held copy can go stale.
 */
export function mayReattemptAfterDefinitelyUnsent(attemptsAlreadyMade: number): boolean {
  return attemptsAlreadyMade < MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS;
}
