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
// bridge, opened by the first watcher and closed by the last.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useProviderQuotas } from "./provider-account-quota.js";
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
  #openCount = 0;
  #closeCount = 0;
  #listCallCount = 0;

  public constructor(private readonly reply: unknown) {
    this.bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string) => {
            if (method !== "providerAccount.list") {
              throw new Error(`unexpected daemon call: ${method}`);
            }
            this.#listCallCount += 1;
            return this.reply;
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
}

/** The readings the hook publishes, captured out of a render. */
interface MountedQuotas {
  readonly readingsNow: () => readonly ProviderQuotaReading[];
  readonly refusalCodeNow: () => string | undefined;
  readonly unmount: () => void;
}

async function mountQuotas(bridge: ConsoleBridge): Promise<MountedQuotas> {
  let readings: readonly ProviderQuotaReading[] = [];
  let refusalCode: string | undefined;

  function Probe(): React.JSX.Element {
    const readout = useProviderQuotas(bridge);
    readings = readout.readings;
    refusalCode = readout.readRefusal?.code;
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
});
