import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { RegistrationOutcomeLine } from "../RegistrationOutcomeLine.js";
import {
  IDLE_TOKEN_REGISTRATION,
  readRegistrationFields,
  submitTokenRegistration,
  takeWriteOnlyToken,
  type ProviderAccountRegisterCall,
  type TokenRegistrationOutcome,
} from "../../provider-sign-in-flow.js";

/**
 * `Paste a token instead`: a name and one masked field for a credential the person minted at
 * `provider`, opened by that control and closed by `Cancel`.
 *
 * The token field is write-only by construction: it is read from its own ref in the submit
 * handler, put on the request, and cleared in the same block. It is never a `useState` member
 * or a `FormData` entry, so no devtools inspection or crash report can capture it, and the
 * registration reply carries no token member to echo. `type="password"` keeps the value off
 * the screen; the ref keeps it out of renderer state; they guard against different observers.
 */
export function TokenRegistrationForm(props: {
  readonly register: ProviderAccountRegisterCall;
  /** The provider the pasted token was minted at; the form sits under its name. */
  readonly provider: ProviderName;
  /** The accounts already registered, whose names a new one must differ from per provider. */
  readonly accounts: readonly ProviderAccount[];
}): ReactNode {
  const { register, provider, accounts } = props;
  const nameFieldId = useId();
  const tokenFieldId = useId();
  const displayLabelInput = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<TokenRegistrationOutcome>(IDLE_TOKEN_REGISTRATION);

  if (!isOpen) {
    return (
      <button
        type="button"
        className="meridian-settings-page__action meridian-action-button"
        onClick={() => {
          setIsOpen(true);
        }}
      >
        Paste a token instead
      </button>
    );
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The ordinary fields are read and judged before the token is touched, so a form that
    // cannot be sent leaves the credential where the person put it; `required` accepts a name
    // of spaces.
    const reading = readRegistrationFields(
      { displayLabel: displayLabelInput.current?.value ?? "", provider },
      accounts,
    );
    if (reading.kind === "refused") {
      setOutcome({ kind: "refused", refusal: reading.refusal });
      return;
    }
    // Read once, sent once, cleared immediately, and only on the path that dispatches; nothing
    // above this handler holds the value.
    const nonInteractiveToken = takeWriteOnlyToken(tokenInput.current);
    setOutcome({ kind: "submitting" });
    void submitTokenRegistration(register, { ...reading.fields, nonInteractiveToken }).then(
      setOutcome,
    );
  };

  return (
    <form className="meridian-accounts__register" onSubmit={onSubmit}>
      <label htmlFor={nameFieldId} className="meridian-form__label">
        Name
      </label>
      <input
        className="meridian-form__input"
        id={nameFieldId}
        ref={displayLabelInput}
        type="text"
        required
      />

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
      {provider === "claude" ? (
        <p className="meridian-settings-page__aside">
          A pasted Claude token&rsquo;s limits are checked every five minutes with one short message
          on the smallest model. Each check counts toward this account&rsquo;s spend.
        </p>
      ) : null}
      <p className="meridian-settings-page__aside">
        The value is stored in this machine&rsquo;s keychain and is never shown here again.
      </p>

      <span className="meridian-accounts__register-actions">
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
            setIsOpen(false);
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
