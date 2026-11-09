// What every surface names an account by: the identity its provider reported, the plan in the
// provider's own word, or for a pasted token or API key the name the person gave it beside the
// credential's kind. The Rust label reads the same case table, parsed strictly here with zod, so
// the service and the desktop name an account alike.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../../__tests__/case-table.test-support.js";
import { validateProviderAccount } from "../../../generated/provider/account/record.js";
import { accountLabel } from "../label.js";

const accountLabelTable = readCaseTable(
  z
    .object({
      providers: z.record(
        z.string(),
        z
          .object({
            name: z.string(),
            planWords: z.array(z.object({ plan: z.string(), word: z.string() }).strict()),
          })
          .strict(),
      ),
      account: z.record(z.string(), z.unknown()),
      cases: z.array(
        z
          .object({
            name: z.string(),
            overrides: z.record(z.string(), z.unknown()),
            label: z.string().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  "account-label.json",
);

describe("accountLabel", () => {
  it.each(accountLabelTable.cases)("names $name", ({ overrides, label }) => {
    const account: unknown = { ...accountLabelTable.account, ...overrides };
    if (!validateProviderAccount(account)) {
      expect.fail("the case's account is a provider account");
    }
    const words = accountLabelTable.providers[account.provider] ?? expect.fail("provider words");
    expect(accountLabel(account, words.name, words.planWords) ?? null).toBe(label);
  });
});
