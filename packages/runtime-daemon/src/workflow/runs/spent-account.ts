// A spent provider account as a waiting step and the runs-needing-you section name it: read from
// `provider_accounts` beside the step that waits on it, and labeled the way every surface labels
// an account. A step's wait outlives the account's row when the account is removed while the step
// is parked on it, so a read names the account only while its row is stored.

import { accountLabel } from "@ai-sidekicks/contracts/provider/account/label";
import type {
  ProviderAccountId,
  ProviderAuthMode,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { WorkflowSpentAccount } from "@ai-sidekicks/contracts/workflow/run/step/record";

/**
 * The `provider_accounts` columns a spent account is named from, as {@link spentAccountColumns}
 * selects them; every one is null where no account row matched.
 */
export interface SpentAccountColumns {
  readonly account_provider: ProviderName | null;
  readonly account_display_label: string | null;
  readonly account_observed_auth_mode: ProviderAuthMode | null;
  readonly account_observed_email: string | null;
  readonly account_observed_plan: string | null;
  readonly account_observed_org_name: string | null;
}

/**
 * The select-list that reads {@link SpentAccountColumns} from the `provider_accounts` row joined
 * under `accountAlias`.
 */
export function spentAccountColumns(accountAlias: string): string {
  return [
    `${accountAlias}.provider AS account_provider`,
    `${accountAlias}.display_label AS account_display_label`,
    `${accountAlias}.observed_auth_mode AS account_observed_auth_mode`,
    `${accountAlias}.observed_account_email AS account_observed_email`,
    `${accountAlias}.observed_account_plan AS account_observed_plan`,
    `${accountAlias}.observed_account_org_name AS account_observed_org_name`,
  ].join(", ");
}

/**
 * The spent account `providerAccountId` names, from its joined columns, or undefined where no
 * account row matched because the account was removed. Throws when a stored account has no label,
 * which a provider account that has run a step always has.
 */
export function spentAccountFromColumns(
  providerAccountId: string,
  columns: SpentAccountColumns,
): WorkflowSpentAccount | undefined {
  if (columns.account_provider === null) {
    return undefined;
  }
  const label = accountLabel({
    provider: columns.account_provider,
    displayLabel: columns.account_display_label ?? undefined,
    observedAuthMode: columns.account_observed_auth_mode,
    observedAccountEmail: columns.account_observed_email ?? undefined,
    observedAccountPlan: columns.account_observed_plan ?? undefined,
    observedAccountOrgName: columns.account_observed_org_name ?? undefined,
  });
  if (label === undefined) {
    throw new Error(`A step waits on provider account ${providerAccountId}, which has no label`);
  }
  return {
    providerAccountId: providerAccountId as ProviderAccountId,
    provider: columns.account_provider,
    label,
  };
}
