// One provider's row: its state, its remedy, its two acts, and what was observed.
//
// SPLIT FROM `ProviderReadinessStep.tsx`, which owns the step. This module owns one
// provider, and the whole of what the console is allowed to say about it: the state
// label and its sentence, the remedy as TEXT, a sign-in control only where the daemon
// composed the `sign_in` arm, a re-check only where an account actually resolved, and
// a disclosure carrying the wire figures verbatim.
//
// THE REMEDY IS NEVER AN EXECUTABLE CONTROL. `register` and `choose_default` are
// mutating registry verbs the account registry owns; a button here would be a second
// place that registry is written from, so those two arms render as a headline and
// nothing else.
//
// NO STALENESS BADGE. `observedAt` is rendered as the wire value it is — the contract
// carries no read-path age test and no stale arm, so a badge would be this console
// inventing a freshness policy and applying it to somebody else's reading.

import type { ProviderAccountId, ProviderReadiness } from "@ai-sidekicks/contracts";

import { InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import {
  OBSERVED_AT_UNSET_NOTE,
  READINESS_STATE_LABELS,
  READINESS_STATE_NOTES,
  remedyHeadline,
} from "./provider-readiness-copy.js";
import type { ProviderActionReading } from "./provider-readiness.js";

export interface ProviderRowProps {
  readonly entry: ProviderReadiness;
  readonly accountLabels: readonly string[];
  readonly action: ProviderActionReading;
  readonly onSignIn: (providerName: string) => void;
  readonly onRecheck: (providerName: string, accountId: ProviderAccountId) => void;
}

export function ProviderRow(props: ProviderRowProps): React.JSX.Element {
  const { entry } = props;
  const { resolvedAccountId } = entry;
  const isBusy = props.action.kind === "handing-off" || props.action.kind === "rechecking";
  return (
    <li className="meridian-onboarding__provider">
      <div className="meridian-onboarding__provider-head">
        <WireFigure value={entry.provider} />
        <span className="meridian-onboarding__badge">{READINESS_STATE_LABELS[entry.state]}</span>
      </div>
      <p className="meridian-onboarding__note">{READINESS_STATE_NOTES[entry.state]}</p>
      {entry.remedy === undefined ? null : (
        <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
          {remedyHeadline(entry.remedy)}
        </p>
      )}
      <div className="meridian-onboarding__step-actions">
        {entry.remedy?.kind === "sign_in" ? (
          <button
            type="button"
            className="meridian-onboarding__act"
            onClick={() => {
              props.onSignIn(entry.provider);
            }}
            disabled={isBusy}
          >
            Sign in to this provider
          </button>
        ) : null}
        {resolvedAccountId === undefined ? null : (
          <button
            type="button"
            className="meridian-onboarding__act meridian-onboarding__act--secondary"
            onClick={() => {
              props.onRecheck(entry.provider, resolvedAccountId);
            }}
            disabled={isBusy}
          >
            Check again
          </button>
        )}
      </div>
      {renderAction(props.action)}
      <details className="meridian-onboarding__detail">
        <summary>What was observed</summary>
        <dl className="meridian-onboarding__figures">
          <dt>Last observed</dt>
          <dd>
            {entry.observedAt === undefined ? (
              OBSERVED_AT_UNSET_NOTE
            ) : (
              <WireFigure value={entry.observedAt} />
            )}
          </dd>
          {resolvedAccountId === undefined ? null : (
            <>
              <dt>Account this provider resolves to</dt>
              <dd>
                <WireFigure value={resolvedAccountId} />
              </dd>
            </>
          )}
          {entry.remedy?.kind === "sign_in" ? (
            <>
              <dt>Sign-in this remedy names</dt>
              <dd>
                <WireFigure value={entry.remedy.signInInvocation} />
              </dd>
              <dt>Credential home it authenticates into</dt>
              <dd>
                <WireFigure value={entry.remedy.credentialHomePath} />
              </dd>
            </>
          ) : null}
          <dt>Accounts registered for this provider</dt>
          <dd>{props.accountLabels.length === 0 ? "None." : props.accountLabels.join(", ")}</dd>
        </dl>
      </details>
    </li>
  );
}

/** What this window has done about this provider since the step opened. */
function renderAction(action: ProviderActionReading): React.ReactNode {
  switch (action.kind) {
    case "idle":
      return null;
    case "handing-off":
      return (
        <Nothing
          kind="computing"
          placement="inline"
          title="Handing off to the provider"
          detail="The provider's own sign-in is being started by the daemon. Nothing it writes is read by this console."
        />
      );
    case "handed-off":
      return (
        <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
          The sign-in was started. Whether it worked is what the reading above says next, never the
          fact that it was started.
        </p>
      );
    case "rechecking":
      return (
        <Nothing
          kind="computing"
          placement="inline"
          title="Checking this account again"
          detail="One deliberate observation, asked for by you."
        />
      );
    case "refused":
      return <InlineRefusal {...action.refusal} />;
  }
}
