import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/account";
import { useState, type ReactNode } from "react";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import type { ProviderAccountProbeCall } from "../provider-sign-in-flow.js";

/** The subsystem name a refused check carries when the call raised no refusal of its own. */
const ACCOUNT_CHECK_REFUSAL_ORIGIN = "provider-account-check";

/**
 * `Check now` on one account, settling in place.
 *
 * The daemon decides whether the press reads again or answers with a read under a minute old,
 * so the page keeps no timer and draws the same settled line either way. A settled check asks
 * for a fresh registry read, since the row's state comes from the registry.
 */
export function AccountCheckNow(props: {
  readonly accountId: ProviderAccountId;
  readonly probe: ProviderAccountProbeCall;
  readonly onChecked: () => void;
}): ReactNode {
  const { accountId, probe, onChecked } = props;
  const [check, setCheck] = useState<AccountCheck>({ kind: "idle" });
  return (
    <div className="meridian-settings-page__state">
      <button
        type="button"
        className="meridian-settings-page__action meridian-action-button"
        disabled={check.kind === "checking"}
        onClick={() => {
          setCheck({ kind: "checking" });
          probe({ accountId }).then(
            () => {
              setCheck({ kind: "checked" });
              onChecked();
            },
            (error: unknown) => {
              setCheck({
                kind: "refused",
                refusal: coerceToRefusal(error, ACCOUNT_CHECK_REFUSAL_ORIGIN, "check-failed"),
              });
            },
          );
        }}
      >
        Check now
      </button>
      {check.kind === "checked" ? <p role="status">That account was checked again.</p> : null}
      {check.kind === "refused" ? (
        <p
          className="meridian-settings-page__state meridian-settings-page__state--failed"
          role="alert"
        >
          <InlineRefusal {...check.refusal} />
        </p>
      ) : null}
    </div>
  );
}

/** Where one press of `Check now` has got to. */
type AccountCheck =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "checked" }
  | { readonly kind: "refused"; readonly refusal: Refusal };
