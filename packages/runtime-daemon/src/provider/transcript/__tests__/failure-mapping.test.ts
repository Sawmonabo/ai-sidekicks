import { describe, expect, it } from "vitest";

import {
  AmbiguousDeliveryReconciler,
  MAX_DEFINITELY_UNSENT_DISPATCH_ATTEMPTS,
  NO_USER_TURN_READER_BOUND,
  USER_TURN_READ_FAILED,
  PermanentStructuralRefusalError,
  classifyProviderRequestFailure,
  mayReattemptAfterDefinitelyUnsent,
  type AmbiguousDeliverySettlement,
  type UserTurnReadback,
  type ProviderRequestDeliveryClass,
  type ProviderRequestFailureDisposition,
  type ProviderRefusalShape,
} from "../failure-mapping.js";

// A structurally invalid history is a permanent refusal, never a retry, and a request whose
// outcome a connection loss left unknown is settled by reading the target, not by guessing.
// Each driver's dispatch tests assert the routing where the provider call count is observable;
// this file asserts the classification table and the reconcile ordering.

// --------------------------------------------------------------------------
// The classification table
// --------------------------------------------------------------------------

interface ClassificationRow {
  readonly delivery: ProviderRequestDeliveryClass;
  readonly refusalShape: ProviderRefusalShape | undefined;
  readonly expected: ProviderRequestFailureDisposition;
}

/** Every reachable observation; a table so the check below can see an unproduced disposition. */
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
  // An untyped refusal never escalates: the permanent arm condemns a binding, so it needs a typed
  // claim.
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
    // Catches an arm deleted or retyped to a neighbor, which would shrink the table silently.
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
    // A typed refusal beside a delivery that saw no answer is a driver wiring bug. The disposition
    // is unaffected; the ignored shape is surfaced so a test can catch the bug.
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
    // The message names the target and tells the reader to reconstitute, not retry.
    expect(error.message).toContain("thread-7");
    expect(error.message).toContain("reconstituted");
  });
});

// --------------------------------------------------------------------------
// The positional reconcile
// --------------------------------------------------------------------------

function countedReadback(userOriginatedTurns: number): () => Promise<UserTurnReadback> {
  return () => Promise.resolve({ kind: "counted", userOriginatedTurns });
}

async function settle(
  reconciler: AmbiguousDeliveryReconciler,
  acknowledgedUserSends: number,
): Promise<AmbiguousDeliverySettlement> {
  return await reconciler.reconcileThenAct(
    { targetProviderSessionId: "thread-1", acknowledgedUserSends },
    (settlement) => Promise.resolve(settlement),
  );
}

describe("AmbiguousDeliveryReconciler", () => {
  it("settles DELIVERED when the target holds more than the daemon acknowledged", async () => {
    const settlement = await settle(new AmbiguousDeliveryReconciler(countedReadback(4)), 3);
    expect(settlement).toStrictEqual({ settlement: "delivered", userOriginatedTurns: 4 });
  });

  it("CLEARS FOR RETRY when the count matches what the daemon already knows", async () => {
    // The acknowledged count excludes the ambiguous request, so an equal count means it never
    // landed.
    const settlement = await settle(new AmbiguousDeliveryReconciler(countedReadback(3)), 3);
    expect(settlement).toStrictEqual({
      settlement: "cleared-for-retry",
      userOriginatedTurns: 3,
    });
  });

  it("does NOT read a shortfall as evidence the ambiguous turn landed", async () => {
    // Fewer turns than acknowledged is a disagreement about history, not proof this turn landed.
    const settlement = await settle(new AmbiguousDeliveryReconciler(countedReadback(1)), 3);
    expect(settlement.settlement).toBe("cleared-for-retry");
  });

  it("settles UNRECOVERABLE when no reader is bound", async () => {
    const reconciler = new AmbiguousDeliveryReconciler();
    expect(reconciler.canReadUserTurns).toBe(false);
    // An unbound reader settles the same way an unreadable target does.
    expect(await settle(reconciler, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: NO_USER_TURN_READER_BOUND,
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
    // The caller is settling a turn; a propagated reader exception is a failure it cannot classify.
    expect(await settle(reconciler, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: USER_TURN_READ_FAILED,
    });
  });

  it("holds the read and the ACT in one critical section per target", async () => {
    // No concurrent send on the same target may run between the read that authorized an act and
    // the act.
    const order: string[] = [];
    let acknowledged = 0;
    const reconciler = new AmbiguousDeliveryReconciler((targetProviderSessionId) => {
      order.push(`read:${targetProviderSessionId}:${String(acknowledged)}`);
      return Promise.resolve({ kind: "counted", userOriginatedTurns: acknowledged });
    });
    const send = async (label: string): Promise<void> => {
      await reconciler.reconcileThenAct(
        { targetProviderSessionId: "thread-1", acknowledgedUserSends: acknowledged },
        async () => {
          await Promise.resolve();
          order.push(`act:${label}`);
          // The append moves both counts, so a read inside this act would compare a stale pair.
          acknowledged += 1;
        },
      );
    };

    await Promise.all([send("first"), send("second")]);

    expect(order).toStrictEqual(["read:thread-1:0", "act:first", "read:thread-1:1", "act:second"]);
  });

  it("lets different targets reconcile concurrently", async () => {
    // The lock is per target; a global one would serialize unrelated sessions.
    const started: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstReadReached = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconciler = new AmbiguousDeliveryReconciler((targetProviderSessionId) => {
      started.push(targetProviderSessionId);
      return Promise.resolve({ kind: "counted", userOriginatedTurns: 0 });
    });

    const held = reconciler.reconcileThenAct(
      { targetProviderSessionId: "thread-1", acknowledgedUserSends: 0 },
      async () => {
        await firstReadReached;
      },
    );
    await reconciler.reconcileThenAct(
      { targetProviderSessionId: "thread-2", acknowledgedUserSends: 0 },
      () => Promise.resolve(),
    );
    releaseFirst();
    await held;

    expect(started).toStrictEqual(["thread-1", "thread-2"]);
  });

  it("keeps a target's queue ordered after an act that THREW", async () => {
    // A throwing act must not reject the next caller for someone else's reason or leak an
    // unhandled rejection.
    const order: string[] = [];
    const reconciler = new AmbiguousDeliveryReconciler(countedReadback(0));
    const failing = reconciler
      .reconcileThenAct(
        { targetProviderSessionId: "thread-1", acknowledgedUserSends: 0 },
        async () => {
          await Promise.resolve();
          order.push("first");
          throw new Error("the act failed");
        },
      )
      .catch((error: unknown) => error);

    const following = reconciler.reconcileThenAct(
      { targetProviderSessionId: "thread-1", acknowledgedUserSends: 0 },
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
