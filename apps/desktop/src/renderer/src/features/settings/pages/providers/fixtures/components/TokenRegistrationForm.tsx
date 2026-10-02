import { BILLING_MODES, PROVIDER_NAMES } from "@ai-sidekicks/contracts";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { RegistrationOutcomeLine } from "./RegistrationOutcomeLine.js";
import {
  IDLE_TOKEN_REGISTRATION,
  readRegistrationFields,
  submitTokenRegistration,
  type ProviderAccountRegisterCall,
  type TokenRegistrationOutcome,
} from "../provider-sign-in-flow.js";

/**
 * Register an account, optionally under a vendor-minted non-interactive token.
 *
 * The token field is write-only by construction: it is read from its own ref in the submit
 * handler, put on the request, and cleared in the same block. It is never a `useState` member
 * or a `FormData` entry, so no devtools inspection or crash report can capture it, and the
 * registration reply carries no token member to echo. `type="password"` keeps the value off
 * the screen; the ref keeps it out of renderer state; they guard against different observers.
 */
export function TokenRegistrationForm(props: {
  readonly register: ProviderAccountRegisterCall;
}): ReactNode {
  const { register } = props;
  const labelFieldId = useId();
  const providerFieldId = useId();
  const billingFieldId = useId();
  const tokenFieldId = useId();
  const displayLabelInput = useRef<HTMLInputElement>(null);
  const providerSelect = useRef<HTMLSelectElement>(null);
  const billingSelect = useRef<HTMLSelectElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<TokenRegistrationOutcome>(IDLE_TOKEN_REGISTRATION);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The ordinary fields are read and judged before the token is touched, so a form that
    // cannot be sent leaves the credential where the person put it; `required` accepts a label
    // of spaces.
    const reading = readRegistrationFields({
      displayLabel: displayLabelInput.current?.value ?? "",
      provider: providerSelect.current?.value ?? "",
      billingMode: billingSelect.current?.value ?? "",
    });
    if (reading.kind === "refused") {
      setOutcome({ kind: "refused", refusal: reading.refusal });
      return;
    }
    // Read once, sent once, cleared immediately, and only on the path that dispatches; nothing
    // above this handler holds the value.
    const nonInteractiveToken = tokenInput.current?.value ?? "";
    if (tokenInput.current !== null) {
      tokenInput.current.value = "";
    }
    setOutcome({ kind: "submitting" });
    void submitTokenRegistration(register, {
      ...reading.fields,
      // Absent rather than empty when nothing was typed: an empty string is a token the
      // daemon would refuse, reporting a blank field as a rejected credential.
      ...(nonInteractiveToken === "" ? {} : { nonInteractiveToken }),
    }).then(setOutcome);
  };

  return (
    <form className="meridian-accounts__register" onSubmit={onSubmit}>
      <label htmlFor={labelFieldId}>Label</label>
      <input id={labelFieldId} ref={displayLabelInput} type="text" required />

      <label htmlFor={providerFieldId}>Provider</label>
      <select id={providerFieldId} ref={providerSelect} defaultValue={PROVIDER_NAMES[0]}>
        {PROVIDER_NAMES.map((provider) => (
          <option key={provider} value={provider}>
            {provider}
          </option>
        ))}
      </select>

      <label htmlFor={billingFieldId}>Billing mode</label>
      <select id={billingFieldId} ref={billingSelect} defaultValue={BILLING_MODES[0]}>
        {BILLING_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>

      <label htmlFor={tokenFieldId}>Non-interactive token</label>
      <input
        id={tokenFieldId}
        ref={tokenInput}
        type="password"
        autoComplete="off"
        spellCheck={false}
      />
      <p className="meridian-settings-page__aside">
        Optional. Submitted once and never read back — this page has no way to show it again, and
        the registration reply carries no field for it.
      </p>

      <button
        type="submit"
        className="meridian-settings-page__action meridian-settings-page__action--primary meridian-action-button"
        disabled={outcome.kind === "submitting"}
      >
        Register account
      </button>
      <RegistrationOutcomeLine outcome={outcome} />
    </form>
  );
}
