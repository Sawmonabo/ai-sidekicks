// Which provider accounts a view lists, and the label it lists each under. An account still
// signing in that its provider has not named yet has no label, so it has no row until its sign-in
// ends.

import { accountLabel } from "@ai-sidekicks/contracts/provider/account/label";
import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";

/** A provider account as a view lists it, with the label every surface names it by. */
export type ListedProviderAccount = ProviderAccount & { readonly label: string };

/** `account` as a view lists it, or `undefined` while its provider has not named it. */
export function listedAccount(account: ProviderAccount): ListedProviderAccount | undefined {
  const label = accountLabel(account);
  return label === undefined ? undefined : { ...account, label };
}
