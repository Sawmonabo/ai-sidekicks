import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider-account";
import { useState } from "react";

import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import type { WireRefusal } from "@renderer/lib/wire-rejection.js";
import type { ProviderAccountSetCurrentCall } from "../provider-sign-in-flow.js";

/** Where the newest `Set as default` press has got to, and on which account. */
export type AccountDefaultMove =
  | { readonly kind: "idle" }
  | { readonly kind: "moving"; readonly accountId: ProviderAccountId }
  | {
      readonly kind: "refused";
      readonly accountId: ProviderAccountId;
      readonly refusal: WireRefusal;
    };

/**
 * The one `Set as default` act the page holds, shared by the button and the row press, which do
 * exactly the same thing. A move that lands asks for a fresh registry read, which moves the mark;
 * a refused one is kept, with the refusal's own members, for the account it named.
 */
export function useAccountDefaultMove(
  setCurrent: ProviderAccountSetCurrentCall,
  onMoved: () => void,
): { readonly move: AccountDefaultMove; readonly setAsDefault: (id: ProviderAccountId) => void } {
  const [move, setMove] = useState<AccountDefaultMove>({ kind: "idle" });
  const setAsDefault = (accountId: ProviderAccountId): void => {
    setMove({ kind: "moving", accountId });
    setCurrent({ accountId }).then(
      () => {
        setMove({ kind: "idle" });
        onMoved();
      },
      (error: unknown) => {
        setMove({
          kind: "refused",
          accountId,
          refusal: coerceToRefusal(error, ACCOUNT_DEFAULT_MOVE_ORIGIN, "set-default-failed"),
        });
      },
    );
  };
  return { move, setAsDefault };
}

/** The subsystem name a refused move carries when the call raised no refusal of its own. */
const ACCOUNT_DEFAULT_MOVE_ORIGIN = "provider-account-default";
