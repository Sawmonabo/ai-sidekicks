// A receipt whose figures do not add up dropped or double-counted a row; only this check
// notices.

import { describe, expect, it } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/account";
import type { SessionCostReceipt } from "@ai-sidekicks/contracts/session/cost";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import { verifyReceiptPartitions } from "./cost-receipt-model.js";

/** Two providers, one with voice, whose every level adds up to the one above it. */
function balancedReceipt(): SessionCostReceipt {
  return {
    sessionTotal: {
      sessionId: "session-cost" as SessionId,
      spendLimitUsdMicros: null,
      tokensPerRun: null,
      committedSpendUsdMicros: 4_500_250,
      agentSpend: [],
    },
    providers: [
      {
        driverName: "claude",
        accounts: [
          {
            providerAccountId: "account-work" as ProviderAccountId,
            billingMode: "subscription",
            tokens: 1200,
            usdMicros: 2_000_000,
          },
          {
            providerAccountId: "account-home" as ProviderAccountId,
            billingMode: "metered",
            tokens: 300,
            usdMicros: 500_000,
          },
        ],
        voice: { seconds: 40, usdMicros: 250 },
        subtotalUsdMicros: 2_500_250,
      },
      {
        driverName: "codex",
        accounts: [
          {
            providerAccountId: "account-codex" as ProviderAccountId,
            billingMode: "metered",
            tokens: 900,
            usdMicros: 2_000_000,
          },
        ],
        subtotalUsdMicros: 2_000_000,
      },
    ],
  };
}

describe("the cost receipt's partitions", () => {
  it("accepts a receipt whose accounts, voice and subtotals all add up", () => {
    expect(verifyReceiptPartitions(balancedReceipt())).toStrictEqual({
      providerSubtotals: true,
      sessionTotal: true,
    });
  });

  it("refuses a provider whose rows miss its subtotal by one micro-dollar", () => {
    const receipt = balancedReceipt();
    const [claude] = receipt.providers;
    if (claude === undefined) {
      throw new Error("the balanced receipt has no first provider");
    }
    claude.voice = { seconds: 40, usdMicros: 251 };

    expect(verifyReceiptPartitions(receipt)).toStrictEqual({
      providerSubtotals: false,
      sessionTotal: true,
    });
  });

  it("refuses subtotals that miss the session's committed spend", () => {
    const receipt = balancedReceipt();
    receipt.sessionTotal.committedSpendUsdMicros += 1;

    expect(verifyReceiptPartitions(receipt)).toStrictEqual({
      providerSubtotals: true,
      sessionTotal: false,
    });
  });
});
