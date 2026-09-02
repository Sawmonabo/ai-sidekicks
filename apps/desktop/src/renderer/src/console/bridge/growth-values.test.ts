// The one growth value whose vocabulary the console does not own.
//
// Every other closed set in `growth-values.ts` is the console's, because the corpus
// registers it in a document and no code package carries it. `billingMode` is the
// exception: `@ai-sidekicks/contracts` ships `BillingMode` and its runtime
// enumeration, and this file is what holds the receipt row to them.
//
// WHAT THIS CAN AND CANNOT PROVE. TypeScript is structural, so a hand-written union
// spelling the same three arms is INDISTINGUISHABLE from the imported one for as
// long as the two agree — no assertion here would have failed against the restated
// vocabulary on the day it was written. What it would have failed on is the day the
// package moved and the copy did not, and that is the failure these cases are built
// around: the accepted set is derived from `BILLING_MODES`, the package's own
// runtime enumeration, so a widened contract fails this file rather than reaching a
// surface as a mode it cannot label. The negative control plants exactly that state
// — a union that has fallen one arm behind — and proves the check fires on it.

import { BILLING_MODES, type BillingMode } from "@ai-sidekicks/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { GrowthCostReceiptAccountRow } from "./growth-values.js";

/** The member under test, named once so every case reads the same declaration. */
type ReceiptBillingMode = GrowthCostReceiptAccountRow["billingMode"];

/**
 * One receipt row per billing mode, built from the package's own enumeration.
 *
 * The construction IS the assertion: `BILLING_MODES` is typed `readonly
 * BillingMode[]`, so this only compiles while the row's member accepts every arm the
 * contract ships. Everything else on the row is fixed, because nothing else is what
 * this file is about.
 */
function accountRowPerBillingMode(): readonly GrowthCostReceiptAccountRow[] {
  return BILLING_MODES.map((billingMode) => ({
    providerAccountId: "account-1",
    displayLabel: "Account 1",
    billingMode,
    costCents: 0,
    costStatus: "priced" as const,
  }));
}

describe("the cost receipt's billing mode — the contracts vocabulary, not a copy", () => {
  it("is the package's own type rather than a union that happens to match it", () => {
    expectTypeOf<ReceiptBillingMode>().toEqualTypeOf<BillingMode>();
  });

  it("holds every arm the package enumerates, so a widened contract fails here first", () => {
    // Derived from `BILLING_MODES` rather than listed again: a case naming the three
    // arms would go green against a console that had fallen behind the package,
    // which is the whole defect.
    expect(accountRowPerBillingMode().map((row) => row.billingMode)).toStrictEqual([
      ...BILLING_MODES,
    ]);
  });

  it("labels the honest-absence arm rather than folding it into a billed one", () => {
    // `unknown` says the operator has not labelled the account, which is a different
    // fact from metered spend. Asserted as membership rather than as a rendering:
    // nothing in the console renders this member yet, and a label table minted here
    // would be a vocabulary ahead of its reader.
    expect(BILLING_MODES).toContain("unknown");
  });
});

describe("negative control — a restated vocabulary one arm behind the package", () => {
  it("refuses to hold a contract mode, which is what the copy becomes when it drifts", () => {
    /** The defect class, planted: a hand-written union the package has moved past. */
    type StaleBillingMode = "subscription" | "metered";
    const contractMode: BillingMode = "unknown";

    // @ts-expect-error — the planted union cannot hold every arm `BillingMode` ships,
    // and this line is what proves the assertions above are not vacuous: delete the
    // import and restate the union here and this is the error that stops appearing.
    const stale: StaleBillingMode = contractMode;

    // Read back through `String` so the assertion does not itself have to name a
    // value the planted union rejects — the compile error above is the subject, and
    // this line only proves the planted value survived to be one.
    expect(String(stale)).toBe("unknown");
  });
});
