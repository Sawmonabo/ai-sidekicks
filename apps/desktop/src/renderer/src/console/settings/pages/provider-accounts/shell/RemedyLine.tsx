import type { ProviderReadiness } from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import { WireFigure } from "../../../../primitives/index.js";

/**
 * The one action a remedy names.
 *
 * A module of its own rather than a private declaration beside its one caller: a
 * `.tsx` file declares exactly one component, private ones counted, which is the rule
 * that keeps a component's identity and its file name the same fact.
 */
export function RemedyLine(props: {
  readonly remedy: NonNullable<ProviderReadiness["remedy"]>;
  readonly onStartSignIn: (accountId: NonNullable<ProviderReadiness["resolvedAccountId"]>) => void;
}): ReactNode {
  const { remedy, onStartSignIn } = props;
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
        onClick={() => {
          onStartSignIn(remedy.accountId);
        }}
      >
        Start sign-in
      </button>
    </div>
  );
}
