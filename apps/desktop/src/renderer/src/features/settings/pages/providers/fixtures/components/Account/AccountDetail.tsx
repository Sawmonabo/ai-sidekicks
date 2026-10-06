import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";
import type { ReactNode } from "react";

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatCount, formatDateTime, formatDayDuration } from "#renderer/lib/wire/figures.js";
import {
  DefinitionGrid,
  type DefinitionGridEntry,
} from "#renderer/features/settings/pages/providers/components/DefinitionGrid.js";
import { estimatedReloginDaysAfterSignIn } from "../../quota-rows.js";

/**
 * The selected row's identity axes: the opaque account handle, its generation, when it was
 * signed in, whether the background observer runs for it, and roughly how long a credential of
 * its kind lasts.
 *
 * The re-login horizon is omitted where the registry carries none: an estimate with no anchor
 * is a fabrication, and an "unknown" row would invite treating the present ones as known. Where
 * present it renders as an approximate day count after sign-in, never as a date.
 */
export function AccountDetail(props: { readonly account: ProviderAccount }): ReactNode {
  const { account } = props;
  const entries: DefinitionGridEntry[] = [
    {
      key: "accountId",
      term: <span>Account</span>,
      // The daemon-minted handle, verbatim and in mono; opaque and immutable, and what every
      // other view names this account by.
      definition: <WireFigure value={account.accountId} />,
    },
    {
      key: "credentialGeneration",
      term: <span>Credential generation</span>,
      definition: <DerivedFigure text={formatCount(account.credentialGeneration)} />,
    },
    {
      key: "probeEnabled",
      term: <span>Background observation</span>,
      definition: (
        <span>
          {account.probeEnabled
            ? "The observer refreshes this account's reading on its own."
            : "Silenced for this account. Its reading moves only when something asks."}
        </span>
      ),
    },
  ];
  if (account.loggedInAt !== null) {
    entries.push({
      key: "loggedInAt",
      term: <span>Signed in</span>,
      definition: <DerivedFigure text={formatDateTime(account.loggedInAt)} />,
    });
  }
  const horizonInDays =
    account.loggedInAt === null || account.expectedReloginAtEstimate === null
      ? undefined
      : estimatedReloginDaysAfterSignIn(account.loggedInAt, account.expectedReloginAtEstimate);
  if (horizonInDays !== undefined) {
    entries.push({
      key: "expectedReloginAtEstimate",
      term: <span>Re-login estimate</span>,
      definition: (
        <span>
          About <DerivedFigure text={formatDayDuration(horizonInDays)} /> after sign-in. An estimate
          from the provider’s published issuance interval, not a deadline this machine can vouch
          for.
        </span>
      ),
    });
  }
  return <DefinitionGrid entries={entries} />;
}
