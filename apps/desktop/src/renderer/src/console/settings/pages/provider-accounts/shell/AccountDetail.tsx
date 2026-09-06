import type { ProviderAccount } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import {
  DerivedFigure,
  WireFigure,
  formatCount,
  formatDateTime,
} from "../../../../primitives/index.js";
import { DefinitionGrid, type DefinitionGridEntry } from "../../../shared/DefinitionGrid.js";
import { estimatedReloginDaysAfterSignIn } from "./quota-rows.js";

/**
 * The selected row's identity axes: the opaque account handle, its generation, when it
 * was signed in, whether the background observer runs for it, and roughly how long a
 * credential of its kind lasts.
 *
 * THE RE-LOGIN HORIZON IS OMITTED ENTIRELY WHERE THE REGISTRY CARRIES NONE, rather
 * than rendered as an absence with a dash. An estimate with no anchor is a fabrication
 * and a row saying "unknown" invites a reader to treat the ones that ARE present as
 * known — so the entry is simply not built. Where it is present it renders as an
 * approximate day count after sign-in, never as a date the daemon can vouch for.
 */
export function AccountDetail(props: { readonly account: ProviderAccount }): ReactNode {
  const { account } = props;
  const entries: DefinitionGridEntry[] = [
    {
      key: "accountId",
      term: <span>Account</span>,
      // The daemon-minted handle, verbatim and in mono. It is opaque and immutable and
      // is what every other surface names this account by, so it is shown rather than
      // hidden behind the operator's label.
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
          About <DerivedFigure text={formatCount(horizonInDays)} /> days after sign-in. An estimate
          from the provider’s published issuance interval, not a deadline this machine can vouch
          for.
        </span>
      ),
    });
  }
  return <DefinitionGrid entries={entries} />;
}
