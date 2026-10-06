import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  IDLE_TOKEN_REGISTRATION,
  submitTokenRegistration,
  takeWriteOnlyToken,
  type ProviderAccountRegisterCall,
  type TokenRegistrationOutcome,
} from "../../sign-in/flow.js";
import { RegistrationOutcomeLine } from "../RegistrationOutcomeLine.js";

/**
 * The field a token or API-key account whose login expired takes its freshly minted token in.
 *
 * It replaces the sealed token on the same account, so the account keeps its identity, its spend
 * and its history. The field is write-only like the registration form's: masked, read once in
 * the submit handler, cleared there, and never held in state.
 */
export function TokenResupplyForm(props: {
  readonly account: ProviderAccount;
  readonly register: ProviderAccountRegisterCall;
  /** Asks for a fresh registry read once the token is stored, so the row reads its new state. */
  readonly onTokenStored: () => void;
}): ReactNode {
  const { account, register, onTokenStored } = props;
  const tokenFieldId = useId();
  const tokenInput = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<TokenRegistrationOutcome>(IDLE_TOKEN_REGISTRATION);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nonInteractiveToken = takeWriteOnlyToken(tokenInput.current);
    setOutcome({ kind: "submitting" });
    // The account's own provider, name and billing mode, which the request carries beside the
    // selector; `accountId` makes it a replacement and never a second account.
    void submitTokenRegistration(register, {
      provider: account.provider,
      displayLabel: account.displayLabel,
      billingMode: account.billingMode,
      accountId: account.accountId,
      nonInteractiveToken,
    }).then((settled) => {
      setOutcome(settled);
      if (settled.kind === "registered") {
        onTokenStored();
      }
    });
  };

  return (
    <form className="meridian-accounts__resupply" onSubmit={onSubmit}>
      <label htmlFor={tokenFieldId} className="meridian-visually-hidden">
        Paste the token you minted at the provider.
      </label>
      <input
        className="meridian-form__input"
        id={tokenFieldId}
        ref={tokenInput}
        type="password"
        placeholder="Paste the token you minted at the provider."
        autoComplete="off"
        spellCheck={false}
        required
      />
      <p className="meridian-settings-page__aside">
        The value is stored in this machine&rsquo;s keychain and is never shown here again.
      </p>
      <span className="meridian-accounts__resupply-actions">
        <button
          type="submit"
          className={
            "meridian-settings-page__action " +
            "meridian-settings-page__action--primary meridian-action-button"
          }
          disabled={outcome.kind === "submitting"}
        >
          Register
        </button>
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={() => {
            // Leaves the field empty and the slot under it clear; the remedy stays where it is.
            takeWriteOnlyToken(tokenInput.current);
            setOutcome(IDLE_TOKEN_REGISTRATION);
          }}
        >
          Cancel
        </button>
      </span>
      <RegistrationOutcomeLine outcome={outcome} />
    </form>
  );
}
