import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";
import type { ReactNode } from "react";

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import {
  formatCount,
  formatDateTime,
  formatDayDuration,
  formatZonedDateTime,
} from "#renderer/lib/wire/figures.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import {
  DefinitionGrid,
  type DefinitionGridEntry,
} from "#renderer/features/settings/pages/providers/components/DefinitionGrid.js";
import { estimatedReloginDaysAfterSignIn } from "../../quota-rows.js";

/**
 * The selected account's details: its credential generation, when it was signed in, whether the
 * background observer runs for it, and roughly how long a credential of its kind lasts. Its
 * daemon-minted id is never shown; the heading above names it.
 *
 * The re-login horizon is omitted where the registry carries none: an estimate with no anchor
 * is a fabrication, and an "unknown" row would invite treating the present ones as known. Where
 * present it renders as an approximate day count after sign-in, never as a date.
 */
export function AccountDetail(props: { readonly account: ProviderAccount }): ReactNode {
  const clockLocale = useClockLocale();
  const { account } = props;
  const entries: DefinitionGridEntry[] = [
    {
      key: "credentialGeneration",
      term: <span>Credential generation</span>,
      definition: (
        <WireFigure
          value={formatCount(account.credentialGeneration)}
          title={String(account.credentialGeneration)}
        />
      ),
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
      definition: (
        <WireFigure
          value={formatDateTime(account.loggedInAt, clockLocale)}
          hoverLabel={formatZonedDateTime(account.loggedInAt, clockLocale)}
        />
      ),
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
          from the provider’s published issuance interval, not a set deadline.
        </span>
      ),
    });
  }
  return <DefinitionGrid entries={entries} />;
}
