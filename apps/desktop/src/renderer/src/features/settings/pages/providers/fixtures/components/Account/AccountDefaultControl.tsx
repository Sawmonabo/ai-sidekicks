import type {
  ProviderAccount,
  ProviderAccountId,
} from "@ai-sidekicks/contracts/provider/account/account";
import type { ReactNode } from "react";

import { readCarriedLoginRemedy } from "@renderer/services/provider-accounts/provider-account-refusal-details.js";
import { AccountPlaneRefusal } from "@renderer/features/settings/pages/providers/components/AccountPlaneRefusal.js";
import type { AccountDefaultMove } from "../../hooks/useAccountDefaultMove.js";

/**
 * `Set as default` on an account the mark is not on, under the line saying how that provider's
 * sessions move, and the refusal in place where the move was refused. A refused move names the
 * account's own way back and moves nothing; the account the mark is on draws no control.
 */
export function AccountDefaultControl(props: {
  readonly account: ProviderAccount;
  readonly move: AccountDefaultMove;
  readonly onSetAsDefault: (accountId: ProviderAccountId) => void;
}): ReactNode {
  const { account, move, onSetAsDefault } = props;
  if (account.isDefault) {
    return null;
  }
  const isThisAccount = move.kind !== "idle" && move.accountId === account.accountId;
  return (
    <div className="meridian-settings-page__state">
      <button
        type="button"
        className="meridian-settings-page__action meridian-action-button"
        disabled={isThisAccount && move.kind === "moving"}
        onClick={() => {
          onSetAsDefault(account.accountId);
        }}
      >
        Set as default
      </button>
      <p className="meridian-settings-page__aside">
        New sessions run on this account, and every session already running on this provider moves
        to it at its next request, without stopping. A sidekick or a workflow step set to a specific
        account stays where it is.
      </p>
      {isThisAccount && move.kind === "refused" ? (
        <div
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          role="alert"
        >
          <AccountPlaneRefusal
            refusal={move.refusal}
            provider={account.provider}
            carriedRemedy={readCarriedLoginRemedy(move.refusal)}
            currentSection="providers"
          />
        </div>
      ) : null}
    </div>
  );
}
