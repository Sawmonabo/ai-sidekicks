// Which provider accounts a view lists, and the label it lists each under, worded from the
// account's provider's section in the service's provider list. An account still signing in that
// its provider has not named yet has no label, so it has no row until its sign-in ends.

import { accountLabel } from "@ai-sidekicks/contracts/provider/account/label";
import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";

/** A provider account as a view lists it, with the label every surface names it by. */
export type ListedProviderAccount = ProviderAccount & { readonly label: string };

/**
 * `account` as a view lists it, or `undefined` while its provider has not named it. `section` is
 * the account's provider's section, whose name and plan words the label is worded in.
 */
export function listedAccount(
  account: ProviderAccount,
  section: ProviderSection,
): ListedProviderAccount | undefined {
  const label = accountLabel(account, section.name, section.planWords);
  return label === undefined ? undefined : { ...account, label };
}
