import { describe, expect, it } from "vitest";

import {
  AmbiguousDeliveryReconciler,
  MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS,
  NO_PARTICIPANT_TURN_READER_BOUND,
  PARTICIPANT_TURN_READ_FAILED,
  PermanentStructuralRefusalError,
  classifyProviderRequestFailure,
  mayReattemptAfterDefinitelyUnsent,
  type AmbiguousDeliverySettlement,
  type ParticipantTurnReadback,
  type ProviderRequestDeliveryClass,
  type ProviderRequestFailureDisposition,
  type ProviderRefusalShape,
} from "../failure-mapping.js";

// The permanent-vs-transient refusal classifier (Plan-005 T3.22), verifying
// invariant I-005-9: a structurally invalid history is a permanent refusal and
// never a retry, and the outcome a connection loss left unknown is settled by
// reading the target rather than by guessing at it.
//
// The routing these rules produce is asserted at each driver's dispatch seam,
// where the provider call count is observable; what is asserted here is the
// table itself and the reconcile's ordering, which no driver test can isolate.

// --------------------------------------------------------------------------
// The classification table
// --------------------------------------------------------------------------

interface ClassificationRow {
  readonly delivery: ProviderRequestDeliveryClass;
  readonly refusalShape: ProviderRefusalShape | undefined;
  readonly expected: ProviderRequestFailureDisposition;
}

/**
 * Every reachable observation, exhaustively.
 *
 * Written as a table rather than as six `it` blocks so the coverage check below
 * can assert that no disposition is enumerated in the union and never produced —
 * the failure mode a hand-written suite hides by simply omitting a case.
 */
const CLASSIFICATION_ROWS: readonly ClassificationRow[] = [
  {
    delivery: "consumed-and-refused",
    refusalShape: "history-structurally-invalid",
    expected: "permanent-structural-refusal",
  },
  {
    delivery: "consumed-and-refused",
    refusalShape: "request-otherwise-refused",
    expected: "fail-consumed-and-declined",
  },
  // A refusal the driver could not type does NOT escalate. The permanent arm
  // condemns a binding, so it is reached on a positive typed claim only.
  {
    delivery: "consumed-and-refused",
    refusalShape: undefined,
    expected: "fail-consumed-and-declined",
  },
  { delivery: "unsent", refusalShape: undefined, expected: "retry-definitely-unsent" },
  { delivery: "indeterminate", refusalShape: undefined, expected: "reconcile-ambiguous-delivery" },
];

describe("classifyProviderRequestFailure", () => {
  for (const row of CLASSIFICATION_ROWS) {
    it(`routes ${row.delivery} / ${row.refusalShape ?? "no typed shape"} to ${row.expected}`, () => {
      expect(
        classifyProviderRequestFailure({
          delivery: row.delivery,
          refusalShape: row.refusalShape,
        }).disposition,
      ).toBe(row.expected);
    });
  }

  it("produces every disposition the union declares", () => {
    // The table's own negative control. An arm deleted or retyped to a
    // convenient neighbour would otherwise shrink the matrix silently, and the
    // two arms most worth losing — the permanent one and the declined one —
    // differ only in whether a binding is condemned.
    expect(new Set(CLASSIFICATION_ROWS.map((row) => row.expected))).toStrictEqual(
      new Set([
        "permanent-structural-refusal",
        "fail-consumed-and-declined",
        "retry-definitely-unsent",
        "reconcile-ambiguous-delivery",
      ]),
    );
  });

  it("REPORTS a refusal shape the delivery class made meaningless", () => {
    // A driver reporting a typed refusal beside a delivery that never saw an
    // answer has a wiring bug whose only other symptom is a silently wrong
    // route. The disposition is unaffected — the classification stays total —
    // and the disregarded value is surfaced so a test can catch the wiring.
    const classification = classifyProviderRequestFailure({
      delivery: "indeterminate",
      refusalShape: "history-structurally-invalid",
    });
    expect(classification.disposition).toBe("reconcile-ambiguous-delivery");
    expect(classification.disregardedRefusalShape).toBe("history-structurally-invalid");
  });

  it("reports nothing disregarded on an observation that carried no shape", () => {
    expect(
      classifyProviderRequestFailure({ delivery: "unsent" }).disregardedRefusalShape,
    ).toBeUndefined();
  });
});

describe("PermanentStructuralRefusalError", () => {
  it("carries the reconstitution obligation and the target it applies to", () => {
    const cause = new Error("the provider typed the request bad");
    const error = new PermanentStructuralRefusalError({
      providerSessionId: "thread-7",
      runId: "run-3",
      cause,
    });
    expect(error.providerSessionId).toBe("thread-7");
    expect(error.runId).toBe("run-3");
    expect(error.refusalShape).toBe("history-structurally-invalid");
    expect(error.reconstitutionRequired).toBe(true);
    expect(error.cause).toBe(cause);
    // The message names the target and the remedy, because an operator reading
    // it is being told to reconstitute rather than to retry.
    expect(error.message).toContain("thread-7");
    expect(error.message).toContain("reconstituted");
  });
});

// --------------------------------------------------------------------------
// The positional reconcile
// --------------------------------------------------------------------------

function countedReadback(
  participantOriginatedTurns: number,
): () => Promise<ParticipantTurnReadback> {
  return () => Promise.resolve({ kind: "counted", participantOriginatedTurns });
}

async function settle(
  reconciler: AmbiguousDeliveryReconciler,
  acknowledgedParticipantSends: number,
): Promise<AmbiguousDeliverySettlement> {
  return await reconciler.reconcileThenAct(
    { targetProviderSessionId: "thread-1", acknowledgedParticipantSends },
    (settlement) => Promise.resolve(settlement),
  );
}

describe("AmbiguousDeliveryReconciler", () => {
  it("settles DELIVERED when the target holds more than the daemon acknowledged", async () => {
    const settlement = await settle(new AmbiguousDeliveryReconciler(countedReadback(4)), 3);
    expect(settlement).toStrictEqual({ settlement: "delivered", participantOriginatedTurns: 4 });
  });

  it("CLEARS FOR RETRY when the count matches what the daemon already knows", async () => {
    // Equality, not a range: the acknowledged count excludes the ambiguous
    // request, so a target holding exactly that many turns does not hold it.
    const settlement = await settle(new AmbiguousDeliveryReconciler(countedReadback(3)), 3);
    expect(settlement).toStrictEqual({
      settlement: "cleared-for-retry",
      participantOriginatedTurns: 3,
    });
  });

  it("does NOT read a shortfall as evidence the ambiguous turn landed", async () => {
    // A target holding FEWER turns than acknowledged disagrees about history
    // rather than about this request. Nothing there proves the turn landed, so
    // nothing is suppressed on that basis.
    const settlement = await settle(new AmbiguousDeliveryReconciler(countedReadback(1)), 3);
    expect(settlement.settlement).toBe("cleared-for-retry");
  });

  it("settles UNRECOVERABLE when no reader is bound", async () => {
    const reconciler = new AmbiguousDeliveryReconciler();
    expect(reconciler.canReadParticipantTurns).toBe(false);
    // An unbound reader is a correct settlement rather than a hole: the caller's
    // answer is the same one an unreadable target gets, which is a specified arm.
    expect(await settle(reconciler, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: NO_PARTICIPANT_TURN_READER_BOUND,
    });
  });

  it("settles UNRECOVERABLE when the reader reports the target unreadable", async () => {
    const reconciler = new AmbiguousDeliveryReconciler(() =>
      Promise.resolve({ kind: "unreadable", reason: "the pin publishes no turn read" }),
    );
    expect(await settle(reconciler, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: "the pin publishes no turn read",
    });
  });

  it("contains a THROWING reader rather than replacing the caller's settlement", async () => {
    const reconciler = new AmbiguousDeliveryReconciler(() =>
      Promise.reject(new Error("read failed")),
    );
    // The caller is mid-settlement of a turn. Propagating the reader's exception
    // would hand it a failure it cannot classify in place of one it can.
    expect(await settle(reconciler, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: PARTICIPANT_TURN_READ_FAILED,
    });
  });

  it("holds the read and the ACT in one critical section per target", async () => {
    // The property the count depends on: no concurrent send on the same target
    // may run between the read that authorized it and the act that performs it.
    const order: string[] = [];
    let acknowledged = 0;
    const reconciler = new AmbiguousDeliveryReconciler((targetProviderSessionId) => {
      order.push(`read:${targetProviderSessionId}:${String(acknowledged)}`);
      return Promise.resolve({ kind: "counted", participantOriginatedTurns: acknowledged });
    });
    const send = async (label: string): Promise<void> => {
      await reconciler.reconcileThenAct(
        { targetProviderSessionId: "thread-1", acknowledgedParticipantSends: acknowledged },
        async () => {
          await Promise.resolve();
          order.push(`act:${label}`);
          // The append the read must not race: it moves BOTH counts, so a second
          // read that ran inside this act would compare a stale pair.
          acknowledged += 1;
        },
      );
    };

    await Promise.all([send("first"), send("second")]);

    expect(order).toStrictEqual(["read:thread-1:0", "act:first", "read:thread-1:1", "act:second"]);
  });

  it("lets different targets reconcile concurrently", async () => {
    // Target-scoped, not global: two threads have nothing to say to each other,
    // and queueing one behind the other would serialize unrelated sessions.
    const started: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstReadReached = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconciler = new AmbiguousDeliveryReconciler((targetProviderSessionId) => {
      started.push(targetProviderSessionId);
      return Promise.resolve({ kind: "counted", participantOriginatedTurns: 0 });
    });

    const held = reconciler.reconcileThenAct(
      { targetProviderSessionId: "thread-1", acknowledgedParticipantSends: 0 },
      async () => {
        await firstReadReached;
      },
    );
    await reconciler.reconcileThenAct(
      { targetProviderSessionId: "thread-2", acknowledgedParticipantSends: 0 },
      () => Promise.resolve(),
    );
    releaseFirst();
    await held;

    expect(started).toStrictEqual(["thread-1", "thread-2"]);
  });

  it("keeps a target's queue ordered after an act that THREW", async () => {
    // A reconcile that threw still released the target. Chaining the next caller
    // onto the rejected promise without containing it would reject that caller
    // for someone else's reason — and would leak an unhandled rejection besides.
    const order: string[] = [];
    const reconciler = new AmbiguousDeliveryReconciler(countedReadback(0));
    const failing = reconciler
      .reconcileThenAct(
        { targetProviderSessionId: "thread-1", acknowledgedParticipantSends: 0 },
        async () => {
          await Promise.resolve();
          order.push("first");
          throw new Error("the act failed");
        },
      )
      .catch((error: unknown) => error);

    const following = reconciler.reconcileThenAct(
      { targetProviderSessionId: "thread-1", acknowledgedParticipantSends: 0 },
      () => {
        order.push("second");
        return Promise.resolve("ok" as const);
      },
    );

    expect(await failing).toBeInstanceOf(Error);
    expect(await following).toBe("ok");
    expect(order).toStrictEqual(["first", "second"]);
  });
});

describe("the definitely-unsent ladder", () => {
  it("permits exactly one re-attempt and no more", () => {
    expect(MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS).toBe(2);
    expect(mayReattemptAfterDefinitelyUnsent(1)).toBe(true);
    expect(mayReattemptAfterDefinitelyUnsent(MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS)).toBe(false);
    expect(mayReattemptAfterDefinitelyUnsent(MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS + 1)).toBe(
      false,
    );
  });
});
