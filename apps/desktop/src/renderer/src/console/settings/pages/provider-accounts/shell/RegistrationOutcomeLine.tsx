import type { ReactNode } from "react";

import { InlineRefusal, WireFigure } from "../../../../primitives/index.js";
import type { TokenRegistrationOutcome } from "./signin-flow.js";

/**
 * What the registration did, in the daemon's own words where it refused.
 *
 * A module of its own rather than a private declaration beside the form: a `.tsx` file
 * declares exactly one component, private ones counted.
 */
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
