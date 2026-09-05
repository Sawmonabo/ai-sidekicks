// The account-plane quota reading, asserted where it decides something.
//
// FIVE CLAIMS, and each one is a place the console could start showing a figure the
// registry never sent: the READ is what seeds the chips, the TAIL is what moves one
// of them, a reading behind its own account's generation is marked stale, a frame
// the registered union does not admit moves nothing at all, and a same-window reading
// that moved BACKWARD is held here as it is in the fold.
//
// The supersession rules themselves are asserted in `provider-quota-fold.test.ts`,
// where the disposition is readable directly. What is claimed here is the WIRING —
// that a reading arriving off the tail actually reaches that rule.
//
// The fourth is the defect this module replaced, stated as its own case. The chips
// used to be folded out of `usage.rate_limit_update` rows in a session's timeline —
// a row the daemon binds to the node-scope sentinel session, so no session store
// holds one — and this reading is driven only by the account plane. Pushing a
// timeline-shaped row at it therefore has to change nothing, and the case beside it
// pushes the registered notification so the assertion is not merely a surface that
// stopped updating at all.
//
// Driven through `useProviderQuotas` rather than the reading class, because the
// watcher count is half of what is being claimed: one read and one subscription per
// bridge, opened by the first watcher and closed by the last. This is the same shape
// `queue-feed.test.tsx` takes over its own reading class.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP } from "../core/index.js";

import { useProviderQuotas } from "./provider-quota-feed.js";
import type { ProviderQuotaReading } from "./provider-quota-fold.js";
import type { ConsoleBridge } from "./console-bridge.js";

const ACCOUNT_ID = "acct-team";
const OTHER_ACCOUNT_ID = "acct-personal";
const OBSERVED_AT = "2026-01-01T11:00:00.000Z";

/** One registry row, in the registered shape and nothing narrower. */
function account(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    ...overrides,
  };
}

/** One quota row, in the registered shape and nothing narrower. */
function usageWindow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    limitId: "weekly-all",
    windowMins: 10_080,
    label: "Weekly, all models",
    usedPercent: 62,
    observedAt: OBSERVED_AT,
    observedCredentialGeneration: 1,
    source: "probe",
    ...overrides,
  };
}

function listReply(
  accounts: readonly Record<string, unknown>[],
  usageWindows: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { accounts, usageWindows, readiness: [] };
}

/** How a case wants the registry read to behave. */
interface AccountPlaneOptions {
  /**
   * Park every read until the case settles it by hand.
   *
   * What the buffering cases are about is the window BETWEEN the tail opening and the
   * read's reply landing, and that window does not exist unless the case owns when the
   * reply lands.
   */
  readonly holdsReads?: boolean;
  /** What the SECOND and later reads answer, where a case makes the reads differ. */
  readonly laterReply?: unknown;
}

/**
 * A bridge that answers the registry read and hands the case its own tail.
 *
 * The subscription is captured rather than scripted, because half these cases are
 * about what arrives AFTER the read has settled and a scripted beat would put that
 * moment on the fixture's clock instead of on the case's.
 */
class AccountPlaneBridge {
  readonly bridge: ConsoleBridge;
  #deliver: ((payload: unknown) => void) | undefined = undefined;
  readonly #parkedReads: (() => void)[] = [];
  #openCount = 0;
  #closeCount = 0;
  #listCallCount = 0;

  public constructor(
    private readonly reply: unknown,
    private readonly options: AccountPlaneOptions = {},
  ) {
    this.bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string) => {
            if (method !== "providerAccount.list") {
              throw new Error(`unexpected daemon call: ${method}`);
            }
            this.#listCallCount += 1;
            const replyForThisCall =
              this.#listCallCount === 1 ? this.reply : (this.options.laterReply ?? this.reply);
            if (this.options.holdsReads !== true) {
              return replyForThisCall;
            }
            return new Promise<unknown>((resolveRead) => {
              this.#parkedReads.push(() => {
                resolveRead(replyForThisCall);
              });
            });
          },
          subscribe: (_event: string, handler: (payload: unknown) => void) => {
            this.#openCount += 1;
            this.#deliver = handler;
            return () => {
              this.#closeCount += 1;
              this.#deliver = undefined;
            };
          },
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;
  }

  public get openCount(): number {
    return this.#openCount;
  }

  public get closeCount(): number {
    return this.#closeCount;
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  /** Push one frame down the tail, exactly as the daemon would. */
  public deliver(payload: unknown): void {
    if (this.#deliver === undefined) {
      throw new Error("nothing is subscribed to the account plane");
    }
    this.#deliver(payload);
  }

  /**
   * Let one parked read answer, oldest first by default.
   *
   * The ordinal is exposed so a case can settle the NEWEST read before the one it
   * superseded, which is the order that decides whether an abandoned reply can still
   * seat itself over a fresher one.
   */
  public settleRead(readOrdinal = 0): void {
    const parked = this.#parkedReads[readOrdinal];
    if (parked === undefined) {
      throw new Error(
        `no parked read at ordinal ${String(readOrdinal)}; ${String(this.#parkedReads.length)} are parked`,
      );
    }
    parked();
  }
}

/** The partial-read arm as a case reads it — what the rail would render. */
interface QuotaPartialArm {
  readonly unreadableDeliveryCount: number;
  readonly unreadableRefusalCode: string | undefined;
}

const NOTHING_UNREADABLE: QuotaPartialArm = {
  unreadableDeliveryCount: 0,
  unreadableRefusalCode: undefined,
};

/** The readings the hook publishes, captured out of a render. */
interface MountedQuotas {
  readonly readingsNow: () => readonly ProviderQuotaReading[];
  readonly refusalCodeNow: () => string | undefined;
  readonly partialNow: () => QuotaPartialArm;
  readonly unmount: () => void;
}

async function mountQuotas(bridge: ConsoleBridge): Promise<MountedQuotas> {
  let readings: readonly ProviderQuotaReading[] = [];
  let refusalCode: string | undefined;
  let partial: QuotaPartialArm = NOTHING_UNREADABLE;

  function Probe(): React.JSX.Element {
    const readout = useProviderQuotas(bridge);
    readings = readout.readings;
    refusalCode = readout.readRefusal?.code;
    partial = {
      unreadableDeliveryCount: readout.unreadableDeliveryCount,
      unreadableRefusalCode: readout.unreadableRefusal?.code,
    };
    return <output>{String(readout.readings.length)}</output>;
  }

  let mounted: { unmount: () => void } | undefined;
  await act(async () => {
    mounted = render(<Probe />);
  });
  if (mounted === undefined) {
    throw new Error("the probe did not mount");
  }
  const rendered = mounted;
  return {
    readingsNow: () => readings,
    refusalCodeNow: () => refusalCode,
    partialNow: () => partial,
    unmount: () => {
      rendered.unmount();
    },
  };
}

/** One key's reading, or a thrown failure naming what was there instead. */
function readingAt(
  readings: readonly ProviderQuotaReading[],
  limitId: string,
): ProviderQuotaReading {
  const found = readings.find((reading) => reading.limitId === limitId);
  if (found === undefined) {
    throw new Error(
      `no reading for "${limitId}"; the fold holds ${JSON.stringify(readings.map((r) => r.limitId))}`,
    );
  }
  return found;
}

describe("useProviderQuotas — the read seeds the chips", () => {
  it("turns the reply's windows into readings labelled by their own accounts", async () => {
    const plane = new AccountPlaneBridge(
      listReply(
        [account(), account({ accountId: OTHER_ACCOUNT_ID, displayLabel: "Personal" })],
        [
          usageWindow(),
          usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus", usedPercent: 91 }),
          usageWindow({ accountId: OTHER_ACCOUNT_ID, limitId: "default", label: undefined }),
        ],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow()).toHaveLength(3);
    expect(readingAt(mounted.readingsNow(), "weekly-all").accountLabel).toBe("Team");
    expect(readingAt(mounted.readingsNow(), "weekly-opus").usedPercent).toBe(91);
    // No published label, so the window's own identifier stands in — the most
    // specific true thing the console holds, rather than a composed name.
    expect(readingAt(mounted.readingsNow(), "default").limitLabel).toBe("default");
    expect(plane.listCallCount).toBe(1);
  });

  it("keeps two windows of one length apart by their limit ids", async () => {
    // The pair key, and the whole reason the readings are not keyed by duration: the
    // two windows below are both 10080 minutes, and a duration key keeps one.
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow(), usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow().map((reading) => reading.limitId)).toStrictEqual([
      "weekly-all",
      "weekly-opus",
    ]);
  });

  it("negative control: a window whose account the registry does not carry is dropped", async () => {
    // Without this the seeding case would hold over a fold that rendered every window
    // it was handed, labelling one with an opaque id nobody chose.
    const plane = new AccountPlaneBridge(
      listReply([account()], [usageWindow(), usageWindow({ accountId: "acct-unknown" })]),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow()).toHaveLength(1);
    expect(readingAt(mounted.readingsNow(), "weekly-all").accountId).toBe(ACCOUNT_ID);
  });

  it("says why it holds nothing when the read is refused", async () => {
    const plane = new AccountPlaneBridge({ accounts: "not a list" });
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow()).toStrictEqual([]);
    expect(mounted.refusalCodeNow()).toBe("reply-unreadable");
  });
});

describe("useProviderQuotas — the tail moves one reading", () => {
  it("replaces the newer observation of one (account, limit) and leaves the rest", async () => {
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow(), usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 88, observedAt: "2026-01-01T12:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(88);
    expect(readingAt(mounted.readingsNow(), "weekly-opus").usedPercent).toBe(62);
  });

  it("keeps the newest observation when an older one arrives after it", async () => {
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 5, observedAt: "2025-12-31T23:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(62);
  });

  it("ignores a session-timeline row pushed at it", async () => {
    // The defect this module replaced. `usage.rate_limit_update` is the row the
    // composer used to fold, and it is not a registered account-plane notification —
    // so the envelope below reaches the tail and changes nothing.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        id: "event-1",
        sessionId: "00000000-0000-0000-0000-000000000000",
        sequence: 1,
        type: "usage.rate_limit_update",
        payload: {
          providerAccountId: ACCOUNT_ID,
          limitId: "weekly-all",
          accountLabel: "Team",
          limitLabel: "Weekly, all models",
          usedPercent: 99,
          observedAt: "2026-01-01T13:00:00.000Z",
        },
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(62);
  });

  it("holds the high-water figure when the tail sends a lower one for the same window", async () => {
    // Consumption does not fall inside one window, so a 90%-consumed account must not
    // regress to 20% on a newer timestamp and hide imminent exhaustion until the
    // window actually resets.
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow({ usedPercent: 90, resetsAt: "2026-01-08T00:00:00.000Z" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({
          usedPercent: 20,
          resetsAt: "2026-01-08T00:00:00.000Z",
          observedAt: "2026-01-01T13:00:00.000Z",
        }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(90);
  });

  it("takes the lower figure once the window's own reset horizon has moved", async () => {
    // Negative control on the guard above: a reset horizon that moved IS a new window,
    // so the same lower reading is the ordinary case and must be seated.
    const plane = new AccountPlaneBridge(
      listReply(
        [account()],
        [usageWindow({ usedPercent: 90, resetsAt: "2026-01-08T00:00:00.000Z" })],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({
          usedPercent: 20,
          resetsAt: "2026-01-15T00:00:00.000Z",
          observedAt: "2026-01-01T13:00:00.000Z",
        }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(20);
  });

  it("negative control: the same reading DOES move on the registered notification", async () => {
    // Without this the case above would hold over a tail that had stopped delivering
    // anything at all, which is a different bug wearing the same green.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 99, observedAt: "2026-01-01T13:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(99);
  });
});

describe("useProviderQuotas — a delivery this build cannot read is a partial read", () => {
  it("counts an unreadable delivery and keeps the snapshot it already has", async () => {
    // The chips a person is looking at stay: they are the best reading the console
    // has. What changes is that the console now says the tail carrying the next one
    // is incomplete, instead of presenting the old snapshot as current.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed" });
    });

    expect(mounted.partialNow().unreadableDeliveryCount).toBe(1);
    expect(mounted.partialNow().unreadableRefusalCode).toBe("delivery-unreadable");
    expect(mounted.readingsNow()).toHaveLength(1);
  });

  it("keeps counting, because an unreadable shape is a build fact and not a blip", async () => {
    // Nothing clears this count — deliberately, and unlike the queue's. The registry
    // read answers for an instant the tail has already moved past, so no snapshot may
    // claim to cover a frame that arrived after it.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed" });
      plane.deliver({ kind: "usage_window_updated", accountId: ACCOUNT_ID });
    });

    expect(mounted.partialNow().unreadableDeliveryCount).toBe(2);
  });

  it("negative control: a readable delivery leaves the reading whole", async () => {
    // Without this the cases above would hold over a reading that counted every
    // delivery, readable or not, and the count would mean nothing.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: ACCOUNT_ID });
    });

    expect(mounted.partialNow().unreadableDeliveryCount).toBe(0);
    expect(mounted.partialNow().unreadableRefusalCode).toBeUndefined();
    expect(mounted.readingsNow()).toStrictEqual([]);
  });
});

describe("useProviderQuotas — a reading behind its account's generation is stale", () => {
  it("marks the reading observed under the older generation and no other", async () => {
    const plane = new AccountPlaneBridge(
      listReply(
        [account({ credentialGeneration: 2 })],
        [
          usageWindow({ observedCredentialGeneration: 1 }),
          usageWindow({
            limitId: "weekly-opus",
            label: "Weekly, Opus",
            observedCredentialGeneration: 2,
          }),
        ],
      ),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(true);
    expect(readingAt(mounted.readingsNow(), "weekly-opus").isStale).toBe(false);
  });

  it("re-reads staleness when the account's own generation advances on the tail", async () => {
    // The comparison the timeline fold could not make: the account moved, the stored
    // reading did not, and the chip has to say so without a second quota row arriving.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);
    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(false);

    await act(async () => {
      plane.deliver({ kind: "account_changed", account: account({ credentialGeneration: 2 }) });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(true);
  });

  it("negative control: an account on its original generation marks nothing stale", async () => {
    const plane = new AccountPlaneBridge(
      listReply([account()], [usageWindow(), usageWindow({ limitId: "weekly-opus" })]),
    );
    const mounted = await mountQuotas(plane.bridge);

    expect(mounted.readingsNow().every((reading) => !reading.isStale)).toBe(true);
  });
});

describe("useProviderQuotas — the tail opens before the read, so it is buffered across it", () => {
  /** Let every microtask the read's continuation chain queues actually run. */
  async function settleMicrotasks(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("keeps an account removed when the removal arrives before the snapshot lands", async () => {
    // The snapshot is taken at an instant the tail has already moved past, so applying
    // the removal on arrival let the reply's unconditional writes resurrect the
    // account — and the tail emits no second notification for a mutation it already
    // reported, so it stayed resurrected for the life of the window.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
    });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: ACCOUNT_ID });
    });
    await act(async () => {
      plane.settleRead();
    });
    await settleMicrotasks();

    expect(mounted.readingsNow()).toStrictEqual([]);
  });

  it("keeps a credential generation that advanced before the snapshot landed", async () => {
    // The other half of the same defect: the snapshot's older account row overwrote the
    // newer one, and a stale quota reading then presented itself as current.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
    });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      plane.deliver({ kind: "account_changed", account: account({ credentialGeneration: 2 }) });
    });
    await act(async () => {
      plane.settleRead();
    });
    await settleMicrotasks();

    expect(readingAt(mounted.readingsNow(), "weekly-all").isStale).toBe(true);
  });

  it("re-reads rather than dropping once the hold is full, and the abandoned reply seats nothing", async () => {
    // Past the cap the reading applies what it holds and takes a FRESH read. The
    // abandoned read is settled LAST here on purpose: its reply is the one that could
    // still overwrite a newer snapshot, and the ordinal is what stops it.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
      laterReply: listReply(
        [account({ accountId: OTHER_ACCOUNT_ID, displayLabel: "Personal" })],
        [usageWindow({ accountId: OTHER_ACCOUNT_ID })],
      ),
    });
    const mounted = await mountQuotas(plane.bridge);

    await act(async () => {
      for (
        let delivered = 0;
        delivered <= PROVIDER_QUOTA_PENDING_NOTIFICATION_CAP;
        delivered += 1
      ) {
        plane.deliver({ kind: "account_removed", accountId: `acct-departed-${String(delivered)}` });
      }
    });
    expect(plane.listCallCount).toBe(2);

    // The fresh read answers first, then the one it superseded.
    await act(async () => {
      plane.settleRead(1);
    });
    await settleMicrotasks();
    await act(async () => {
      plane.settleRead(0);
    });
    await settleMicrotasks();

    expect(mounted.readingsNow().map((reading) => reading.accountId)).toStrictEqual([
      OTHER_ACCOUNT_ID,
    ]);
  });

  it("negative control: a notification after the read has settled applies at once", async () => {
    // Without this every case above would hold over a reading that had simply stopped
    // applying notifications, and the buffer would be indistinguishable from a drop.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const mounted = await mountQuotas(plane.bridge);
    expect(mounted.readingsNow()).toHaveLength(1);

    await act(async () => {
      plane.deliver({ kind: "account_removed", accountId: ACCOUNT_ID });
    });

    expect(mounted.readingsNow()).toStrictEqual([]);
    expect(plane.listCallCount).toBe(1);
  });

  it("negative control: nothing is held once the read has answered", async () => {
    // The hold is scoped to the OPENING read. A reading that kept buffering forever
    // would pass the removal case above and never move again.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]), {
      holdsReads: true,
    });
    const mounted = await mountQuotas(plane.bridge);
    await act(async () => {
      plane.settleRead();
    });
    await settleMicrotasks();

    await act(async () => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: usageWindow({ usedPercent: 99, observedAt: "2026-01-01T13:00:00.000Z" }),
      });
    });

    expect(readingAt(mounted.readingsNow(), "weekly-all").usedPercent).toBe(99);
  });
});

describe("useProviderQuotas — one subscription per bridge", () => {
  it("opens once for two watchers and closes when the last leaves", async () => {
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const first = await mountQuotas(plane.bridge);
    const second = await mountQuotas(plane.bridge);

    expect(plane.openCount).toBe(1);
    expect(plane.listCallCount).toBe(1);

    await act(async () => {
      first.unmount();
    });
    expect(plane.closeCount).toBe(0);

    await act(async () => {
      second.unmount();
    });
    expect(plane.closeCount).toBe(1);
  });

  it("leaves one live registered reading when one watcher replaces another in a commit", async () => {
    // Cleanups run before setups, so the arriving watcher's subscribe lands after the
    // leaving one retired the reading. Subscribing through a reading captured at
    // render revived it outside the registry, and the next watcher minted a second —
    // two reads and two tails for the one node-scoped question this answers once.
    const plane = new AccountPlaneBridge(listReply([account()], [usageWindow()]));
    const leaving = await mountQuotas(plane.bridge);
    await act(async () => {
      leaving.unmount();
    });
    const arriving = await mountQuotas(plane.bridge);
    const joining = await mountQuotas(plane.bridge);

    expect(plane.openCount).toBe(2);
    expect(plane.listCallCount).toBe(2);

    // And the reading the swap left behind is the registered one: the joiner shares
    // it, so its departure alone does not close the tail.
    await act(async () => {
      arriving.unmount();
    });
    expect(plane.closeCount).toBe(1);
    await act(async () => {
      joining.unmount();
    });
    expect(plane.closeCount).toBe(2);
  });
});
