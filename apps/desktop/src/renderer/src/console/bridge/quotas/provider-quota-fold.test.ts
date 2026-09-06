// The fold's rules, driven directly rather than through a bridge.
//
// The supersession rules are the reason this module exists apart from the wire: a
// reading held by the same-window high-water guard and a reading held because a newer
// one already stands are two different decisions that a hook-level test can only tell
// apart by the number that ends up on screen. Here the disposition itself is the
// assertion.

import { describe, expect, it } from "vitest";
import {
  ProviderAccountIdSchema,
  type ProviderAccount,
  type ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import { ProviderQuotaFold, quotaMergeDispositionFor } from "./provider-quota-fold.js";

// Minted through the registered schema rather than cast, so a case cannot file a
// reading under an id the wire would refuse.
const ACCOUNT_ID = ProviderAccountIdSchema.parse("acct-team");
const EARLIER = "2026-01-01T11:00:00.000Z";
const LATER = "2026-01-01T12:00:00.000Z";
const WINDOW_RESET = "2026-01-08T00:00:00.000Z";
const NEXT_WINDOW_RESET = "2026-01-15T00:00:00.000Z";

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: EARLIER,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    ...overrides,
  };
}

function usageWindow(
  overrides: Partial<ProviderAccountUsageWindow> = {},
): ProviderAccountUsageWindow {
  return {
    accountId: ACCOUNT_ID,
    limitId: "weekly-all",
    windowMins: 10_080,
    label: "Weekly, all models",
    usedPercent: 90,
    resetsAt: WINDOW_RESET,
    observedAt: EARLIER,
    observedCredentialGeneration: 1,
    source: "probe",
    ...overrides,
  };
}

/** One key's reading, or a thrown failure naming what the fold holds instead. */
function usedPercentFor(fold: ProviderQuotaFold, limitId: string): number {
  const readings = fold.readings();
  const found = readings.find((reading) => reading.limitId === limitId);
  if (found === undefined) {
    throw new Error(
      `no reading for "${limitId}"; the fold holds ${JSON.stringify(readings.map((reading) => reading.limitId))}`,
    );
  }
  return found.usedPercent;
}

describe("quotaMergeDispositionFor — consumption does not fall inside one window", () => {
  it("drops a lower reading in the same window however new its observation is", () => {
    const held = usageWindow({ usedPercent: 90, observedAt: EARLIER });
    const lowerButNewer = usageWindow({ usedPercent: 20, observedAt: LATER });

    expect(quotaMergeDispositionFor(lowerButNewer, held, true)).toBe("dropped-below-high-water");
  });

  it("seats a lower reading once the window itself has moved on", () => {
    // A reset horizon that moved is exactly what a window reset looks like, so this
    // is the ordinary case and not a regression — which is why the guard keys on
    // `resetsAt` rather than on the percentage alone.
    const held = usageWindow({ usedPercent: 90, observedAt: EARLIER });
    const nextWindow = usageWindow({
      usedPercent: 20,
      observedAt: LATER,
      resetsAt: NEXT_WINDOW_RESET,
    });

    expect(quotaMergeDispositionFor(nextWindow, held, true)).toBe("seated");
  });

  it("treats two readings that publish no reset horizon as one continuing window", () => {
    // A provider that publishes no horizon publishes one window, and reading the two
    // absences as different windows would disable the guard for exactly that provider.
    const held = usageWindow({ usedPercent: 90, observedAt: EARLIER, resetsAt: undefined });
    const lowerButNewer = usageWindow({ usedPercent: 20, observedAt: LATER, resetsAt: undefined });

    expect(quotaMergeDispositionFor(lowerButNewer, held, true)).toBe("dropped-below-high-water");
  });

  it("negative control: an equal-or-higher same-window reading is seated on its timestamp", () => {
    // Without this the guard could be an unconditional "hold whatever is stored" and
    // every case above would still be green.
    const held = usageWindow({ usedPercent: 90, observedAt: EARLIER });
    const higher = usageWindow({ usedPercent: 91, observedAt: LATER });

    expect(quotaMergeDispositionFor(higher, held, true)).toBe("seated");
  });

  it("negative control: an older same-window reading is held by observation time", () => {
    // The disposition a reader must not confuse with the guard's: this one is held
    // because something newer stands, and it is worth no diagnostic anywhere.
    const held = usageWindow({ usedPercent: 90, observedAt: LATER });
    const older = usageWindow({ usedPercent: 95, observedAt: EARLIER });

    expect(quotaMergeDispositionFor(older, held, true)).toBe("held");
  });

  it("breaks an exact observation tie by arrival and by nothing else", () => {
    const held = usageWindow({ usedPercent: 90, observedAt: EARLIER });
    const tied = usageWindow({ usedPercent: 92, observedAt: EARLIER });

    expect(quotaMergeDispositionFor(tied, held, true)).toBe("seated");
    expect(quotaMergeDispositionFor(tied, held, false)).toBe("held");
  });
});

describe("ProviderQuotaFold — the readings a surface renders", () => {
  it("keeps the high-water figure when the wire sends a lower one for the same window", () => {
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());
    fold.mergeWindow(usageWindow({ usedPercent: 90, observedAt: EARLIER }));

    expect(fold.mergeWindow(usageWindow({ usedPercent: 20, observedAt: LATER }))).toBe(
      "dropped-below-high-water",
    );
    expect(usedPercentFor(fold, "weekly-all")).toBe(90);
  });

  it("takes the lower figure once the window has reset", () => {
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());
    fold.mergeWindow(usageWindow({ usedPercent: 90, observedAt: EARLIER }));

    expect(
      fold.mergeWindow(
        usageWindow({ usedPercent: 20, observedAt: LATER, resetsAt: NEXT_WINDOW_RESET }),
      ),
    ).toBe("seated");
    expect(usedPercentFor(fold, "weekly-all")).toBe(20);
  });

  it("marks a reading behind its own account's generation stale", () => {
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account({ credentialGeneration: 2 }));
    fold.mergeWindow(usageWindow({ observedCredentialGeneration: 1 }));

    expect(fold.readings()[0]?.isStale).toBe(true);
  });

  it("takes a removed account's readings with it", () => {
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());
    fold.mergeWindow(usageWindow());
    expect(fold.readings()).toHaveLength(1);

    fold.forgetAccount(ACCOUNT_ID);

    expect(fold.readings()).toStrictEqual([]);
  });

  it("negative control: two windows of one length stay apart under their limit ids", () => {
    // The pair key, and the whole reason the readings are not keyed by duration.
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());
    fold.mergeWindow(usageWindow({ usedPercent: 90 }));
    fold.mergeWindow(
      usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus", usedPercent: 30 }),
    );

    expect(usedPercentFor(fold, "weekly-all")).toBe(90);
    expect(usedPercentFor(fold, "weekly-opus")).toBe(30);
  });
});

describe("ProviderQuotaFold — the account labels a surface joins a handle to", () => {
  it("labels an account that has no observed window at all", () => {
    // The membership difference that makes this a second answer rather than a scan
    // over the readings: an account the registry carries has a label whether or not
    // a quota row has ever been observed for it, and a surface naming its handle
    // needs that label. Scanning `readings()` for one would find nothing here.
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());

    expect(fold.readings()).toStrictEqual([]);
    expect([...fold.accountLabels()]).toStrictEqual([[ACCOUNT_ID, "Team"]]);
  });

  it("takes the label the newest seating carries, not the first", () => {
    // The registry sends state and not deltas, so a renamed account is re-seated
    // whole; a label that stuck at the first reading would name the account by a
    // word its operator has already changed.
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());
    fold.seatAccount(account({ displayLabel: "Team (renamed)" }));

    expect(fold.accountLabels().get(ACCOUNT_ID)).toBe("Team (renamed)");
  });

  it("drops a removed account's label, so a stale handle joins to nothing", () => {
    const fold = new ProviderQuotaFold();
    fold.seatAccount(account());
    expect(fold.accountLabels().has(ACCOUNT_ID)).toBe(true);

    fold.forgetAccount(ACCOUNT_ID);

    expect(fold.accountLabels().has(ACCOUNT_ID)).toBe(false);
  });

  it("negative control: the rows are empty before anything is seated", () => {
    // Without this, every assertion above would also pass over a `accountLabels`
    // that answered with one fixed row whatever the fold held.
    expect([...new ProviderQuotaFold().accountLabels()]).toStrictEqual([]);
  });
});
