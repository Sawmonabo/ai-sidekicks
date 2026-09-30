import { describe, expect, it } from "vitest";

import {
  AmbiguousDeliveryReconciler,
  NO_USER_TURN_READER_BOUND,
  USER_TURN_READ_FAILED,
  classifyProviderRequestFailure,
  type AmbiguousDeliverySettlement,
  type UserTurnReadback,
  type ProviderRequestDeliveryClass,
  type ProviderRequestFailureDisposition,
  type ProviderRefusalShape,
} from "../failure-mapping.js";

// A structurally invalid history is a permanent refusal, never a retry, and a request whose
// outcome a connection loss left unknown is settled by reading the target, not by guessing.

// --------------------------------------------------------------------------
// The classification table
// --------------------------------------------------------------------------

interface ClassificationRow {
  readonly delivery: ProviderRequestDeliveryClass;
  readonly refusalShape: ProviderRefusalShape | undefined;
  readonly expected: ProviderRequestFailureDisposition;
}

/** Every reachable observation and the disposition it must route to. */
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
  it("settles DELIVERED only on more turns than acknowledged; equal or fewer clears for retry", async () => {
    const delivered = await settle(new AmbiguousDeliveryReconciler(countedReadback(4)), 3);
    expect(delivered).toStrictEqual({ settlement: "delivered", userOriginatedTurns: 4 });

    // The acknowledged count excludes the ambiguous request, so an equal count means it never
    // landed.
    const cleared = await settle(new AmbiguousDeliveryReconciler(countedReadback(3)), 3);
    expect(cleared).toStrictEqual({
      settlement: "cleared-for-retry",
      userOriginatedTurns: 3,
    });

    // Fewer turns than acknowledged is a disagreement about history, not proof this turn landed.
    const shortfall = await settle(new AmbiguousDeliveryReconciler(countedReadback(1)), 3);
    expect(shortfall.settlement).toBe("cleared-for-retry");
  });

  it("settles UNRECOVERABLE when no reader is bound, the target is unreadable, or the read throws", async () => {
    const unbound = new AmbiguousDeliveryReconciler();
    expect(unbound.canReadUserTurns).toBe(false);
    // An unbound reader settles the same way an unreadable target does.
    expect(await settle(unbound, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: NO_USER_TURN_READER_BOUND,
    });

    const unreadable = new AmbiguousDeliveryReconciler(() =>
      Promise.resolve({ kind: "unreadable", reason: "the pin publishes no turn read" }),
    );
    expect(await settle(unreadable, 3)).toStrictEqual({
      settlement: "unrecoverable",
      reason: "the pin publishes no turn read",
    });

    const throwing = new AmbiguousDeliveryReconciler(() =>
      Promise.reject(new Error("read failed")),
    );
    // The caller is settling a turn; a propagated reader exception is a failure it cannot classify.
    expect(await settle(throwing, 3)).toStrictEqual({
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
