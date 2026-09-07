import { BILLING_MODES, PROVIDER_NAMES, type BillingMode } from "@ai-sidekicks/contracts";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { RegistrationOutcomeLine } from "./RegistrationOutcomeLine.js";
import type { ConsoleBridge } from "../../../../bridge/index.js";
import {
  IDLE_TOKEN_REGISTRATION,
  submitTokenRegistration,
  type TokenRegistrationOutcome,
} from "./signin-flow.js";

/**
 * Register an account, optionally under a vendor-minted non-interactive token.
 *
 * THE TOKEN FIELD IS WRITE-ONLY, AND THAT IS A PROPERTY OF THIS COMPONENT RATHER THAN
 * OF ITS STYLING. Every other field on this form is ordinary uncontrolled input; the
 * token is read from its own ref inside the submit handler, put on the request, and the
 * input is cleared in the same statement block. It is never a `useState` member, never
 * a `FormData` entry, and never anything a devtools inspection or a crash report could
 * capture — which is the guarantee no form library gives for free and the reason this
 * form is written out rather than generated.
 *
 * AND IT IS NEVER ECHOED, WHICH THE WIRE MAKES EASY: the registration reply carries the
 * account and no token member at all, so the settled arm below has nothing to render
 * even for a surface that tried. The one thing this form shows after a success is the
 * account the daemon created.
 *
 * `type="password"` IS FOR THE SHOULDER AND NOT FOR THE PROCESS. It keeps the value off
 * the screen; keeping it out of renderer state is the ref above, and the two are
 * different guarantees against different observers.
 */
export function TokenRegistrationForm(props: { readonly bridge: ConsoleBridge }): ReactNode {
  const { bridge } = props;
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
    const displayLabel = displayLabelInput.current?.value.trim() ?? "";
    const provider = providerSelect.current?.value ?? "";
    const billingMode = billingSelect.current?.value ?? "";
    // Read once, sent once, cleared immediately. The local binding dies with this
    // handler's frame; nothing above it ever holds the value.
    const nonInteractiveToken = tokenInput.current?.value ?? "";
    if (tokenInput.current !== null) {
      tokenInput.current.value = "";
    }
    if (!isProviderName(provider) || !isBillingMode(billingMode) || displayLabel === "") {
      return;
    }
    setOutcome({ kind: "submitting" });
    void submitTokenRegistration(bridge, {
      provider,
      displayLabel,
      billingMode,
      // Absent rather than empty when nothing was typed: the member is optional on the
      // wire and an empty string is a token the daemon would have to refuse, which
      // would report a field left blank as a rejected credential.
      ...(nonInteractiveToken === "" ? {} : { nonInteractiveToken }),
    }).then(setOutcome, () => {
      // Unreachable through the growth seam, which settles its own rejections — but a
      // promise this component drops would leave the form reading "submitting" forever,
      // so the arm exists and says the one true thing it can.
      setOutcome(IDLE_TOKEN_REGISTRATION);
    });
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
        className="meridian-settings-page__action meridian-settings-page__action--primary"
        disabled={outcome.kind === "submitting"}
      >
        Register account
      </button>
      <RegistrationOutcomeLine outcome={outcome} />
    </form>
  );
}

/** Narrow a select's string back to the closed provider set the wire admits. */
function isProviderName(value: string): value is (typeof PROVIDER_NAMES)[number] {
  return PROVIDER_NAMES.some((provider) => provider === value);
}

/** Narrow a select's string back to the closed billing vocabulary the wire admits. */
function isBillingMode(value: string): value is BillingMode {
  return BILLING_MODES.some((mode) => mode === value);
}
