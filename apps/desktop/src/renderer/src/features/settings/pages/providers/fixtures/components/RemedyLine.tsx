import type {
  ProviderAccount,
  ProviderName,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/account";
import type { ReactNode } from "react";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { accountPlaneRemedySentence } from "#renderer/lib/account-plane-sentences.js";
import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import type {
  ProviderAccountProbeCall,
  ProviderAccountRegisterCall,
} from "../provider-sign-in-flow.js";
import { AccountCheckNow } from "./Account/AccountCheckNow.js";
import { TokenResupplyForm } from "./Token/TokenResupplyForm.js";

/**
 * The one remedy that applies to a readiness state, and the one action it names.
 *
 * The start is disabled and never hidden while another sign-in runs: this machine runs one
 * brokered flow at a time, and a vanished control would leave a person looking for the step
 * they were told to take. The reason sits beside it. A refused start renders here, on the row
 * that asked, since the card that watches a live flow is shared across every readiness row. A
 * token account's remedy carries the field its fresh token is pasted into.
 */
export function RemedyLine(props: {
  readonly remedy: NonNullable<ProviderReadiness["remedy"]>;
  /** The state the remedy answers; a sign-in is worded apart for a folder with no credential. */
  readonly state: ProviderReadiness["state"];
  /** The provider the remedy is about, which some remedies name. */
  readonly provider: ProviderName;
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
  /** Why the start may not be pressed right now, where it may not be. */
  readonly startBlockedReason: string | undefined;
  /** The last refusal this row's own start was answered with, where there is one. */
  readonly startRefusal: Refusal | undefined;
  /** The account a token remedy names, as the registry carries it, where it carries it. */
  readonly remedyAccount: ProviderAccount | undefined;
  readonly register: ProviderAccountRegisterCall;
  /** Asks for a fresh registry read once a fresh token is stored or the account was checked. */
  readonly requestRegistryRead: () => void;
  readonly probe: ProviderAccountProbeCall;
}): ReactNode {
  const { remedy, state, provider, onStartSignIn, startBlockedReason, startRefusal } = props;
  if (remedy.kind === "choose_default" || remedy.kind === "register") {
    // The row's state chip already reads these remedies' whole sentence, and their acts live on
    // the account rows and the sign-in and paste forms, so the line would only repeat it.
    return null;
  }
  const sentence = <p>{accountPlaneRemedySentence(remedy.kind, state, provider)}</p>;
  if (remedy.kind === "paste_token") {
    return (
      <div className="meridian-settings-page__state">
        {sentence}
        {props.remedyAccount === undefined ? null : (
          <TokenResupplyForm
            key={props.remedyAccount.accountId}
            account={props.remedyAccount}
            register={props.register}
            onTokenStored={props.requestRegistryRead}
          />
        )}
      </div>
    );
  }
  if (remedy.kind === "look_again") {
    // The sentence names `Check now`, so the control it names sits beside it.
    return (
      <div className="meridian-settings-page__state">
        {sentence}
        <AccountCheckNow
          key={remedy.accountId}
          accountId={remedy.accountId}
          probe={props.probe}
          onChecked={props.requestRegistryRead}
        />
      </div>
    );
  }
  if (remedy.kind !== "sign_in") {
    return <div className="meridian-settings-page__state">{sentence}</div>;
  }
  return (
    <div className="meridian-settings-page__state">
      {sentence}
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
