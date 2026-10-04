import type { ProviderReadiness } from "@ai-sidekicks/contracts/provider-account";
import type { ReactNode } from "react";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { Refusal } from "@renderer/lib/refusal.js";

/**
 * The one action a remedy names.
 *
 * The start is disabled and never hidden while another sign-in runs: this machine runs one
 * brokered flow at a time, and a vanished control would leave a person looking for the step
 * they were told to take. The reason sits beside it. A refused start renders here, on the row
 * that asked, since the card that watches a live flow is shared across every readiness row.
 */
export function RemedyLine(props: {
  readonly remedy: NonNullable<ProviderReadiness["remedy"]>;
  /** The state the remedy answers; a sign-in is worded apart for a folder with no credential. */
  readonly state: ProviderReadiness["state"];
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
  /** Why the start may not be pressed right now, where it may not be. */
  readonly startBlockedReason: string | undefined;
  /** The last refusal this row's own start was answered with, where there is one. */
  readonly startRefusal: Refusal | undefined;
}): ReactNode {
  const { remedy, state, onStartSignIn, startBlockedReason, startRefusal } = props;
  if (remedy.kind === "register") {
    return (
      <p className="meridian-settings-page__state">
        Nothing is registered for this provider. Register an account below, and a run against it
        will refuse until one exists.
      </p>
    );
  }
  if (remedy.kind === "choose_default") {
    return (
      <p className="meridian-settings-page__state">
        Accounts exist for this provider and none of them is the default. Choose one from{" "}
        {remedy.candidateAccountIds.map((candidateId) => (
          <WireFigure key={candidateId} value={candidateId} />
        ))}
        .
      </p>
    );
  }
  if (remedy.kind === "paste_token") {
    return (
      <p className="meridian-settings-page__state">
        This account cannot refresh itself. Mint a fresh token at the provider and paste it.
      </p>
    );
  }
  if (remedy.kind === "look_again") {
    return (
      <p className="meridian-settings-page__state">
        Nothing is wrong that can be seen from here. The next check may settle it.
      </p>
    );
  }
  return (
    <div className="meridian-settings-page__state">
      <p>
        {state === "home_missing"
          ? "Sign in against this account's own folder to put a credential back in it."
          : "Sign in again through the provider's own sign-in, against this account's own folder."}
      </p>
      <p>
        {/* The one credential-home string that reaches the screen; display-only, naming where
            the provider's own sign-in writes. Nothing in that directory is read or rendered. */}
        The provider’s own sign-in authenticates into{" "}
        <WireFigure value={remedy.credentialHomePath} />
        , by running <WireFigure value={remedy.signInInvocation} />.
      </p>
      <button
        type="button"
        className={
          "meridian-settings-page__action " +
          "meridian-settings-page__action--primary meridian-action-button"
        }
        disabled={startBlockedReason !== undefined}
        onClick={() => {
          onStartSignIn(remedy.accountId);
        }}
      >
        Sign in
      </button>
      {startBlockedReason === undefined ? null : (
        <p className="meridian-settings-page__aside">{startBlockedReason}</p>
      )}
      {startRefusal === undefined ? null : (
        <p className="meridian-settings-page__state meridian-settings-page__state--failed">
          <InlineRefusal {...startRefusal} />
        </p>
      )}
    </div>
  );
}
