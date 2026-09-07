import type { ProviderReadiness } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import { InlineRefusal, WireFigure } from "../../../../primitives/index.js";
import type { ConsoleRefusal } from "../../../../core/index.js";

/**
 * The one action a remedy names.
 *
 * A module of its own rather than a private declaration beside its one caller: a
 * `.tsx` file declares exactly one component, private ones counted, which is the rule
 * that keeps a component's identity and its file name the same fact.
 *
 * THE START IS DISABLED AND NEVER HIDDEN while another sign-in holds the plane. This
 * machine runs one brokered flow at a time, so a second start would be refused by the
 * daemon — but a control that vanished would leave a person looking for the step they
 * were told to take, with nothing on screen saying why it went. Disabling it keeps the
 * remedy where it was and puts the reason beside it, which is a fact somebody can act
 * on: finish the other sign-in, or cancel it.
 *
 * AND A REFUSED START RENDERS HERE, on the row that asked. The card that watches a live
 * flow is shared across every readiness row, so a refusal shown there would be a
 * refusal about no particular account.
 */
export function RemedyLine(props: {
  readonly remedy: NonNullable<ProviderReadiness["remedy"]>;
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
  /** Why the start may not be pressed right now, where it may not be. */
  readonly startBlockedReason: string | undefined;
  /** The last refusal this row's own start was answered with, where there is one. */
  readonly startRefusal: ConsoleRefusal | undefined;
}): ReactNode {
  const { remedy, onStartSignIn, startBlockedReason, startRefusal } = props;
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
  return (
    <div className="meridian-settings-page__state">
      <p>
        {/* The one credential-home string that reaches the screen, and it is
            display-only: it names where the provider's own sign-in writes, so an
            operator can tell which home is being authenticated. Nothing about the
            contents of that directory is read or rendered. */}
        The provider’s own sign-in authenticates into{" "}
        <WireFigure value={remedy.credentialHomePath} />
        , by running <WireFigure value={remedy.signInInvocation} />.
      </p>
      <button
        type="button"
        className="meridian-settings-page__action meridian-settings-page__action--primary"
        disabled={startBlockedReason !== undefined}
        onClick={() => {
          onStartSignIn(remedy.accountId);
        }}
      >
        Start sign-in
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
