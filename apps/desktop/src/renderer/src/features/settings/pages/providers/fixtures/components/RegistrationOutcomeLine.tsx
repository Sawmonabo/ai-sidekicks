import type { ReactNode } from "react";

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { TokenRegistrationOutcome } from "../provider-sign-in-flow.js";

/** What the registration did, and the form's own words where it refused the fields. */
export function RegistrationOutcomeLine(props: {
  readonly outcome: TokenRegistrationOutcome;
}): ReactNode {
  const { outcome } = props;
  if (outcome.kind === "idle") {
    return null;
  }
  if (outcome.kind === "submitting") {
    return <p className="meridian-settings-page__state">Registering…</p>;
  }
  if (outcome.kind === "refused") {
    return (
      <p
        className="meridian-settings-page__state meridian-settings-page__state--failed"
        role="alert"
      >
        <InlineRefusal {...outcome.refusal} />
      </p>
    );
  }
  return (
    <p className="meridian-settings-page__state" role="status">
      Registered <WireFigure value={outcome.account.accountId} /> as {outcome.account.displayLabel}.
    </p>
  );
}
