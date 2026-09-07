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
//
// AND AN ACCOUNT LABEL IS A WIRE FIGURE LIKE EVERY OTHER FIGURE HERE. The labels ride
// the registry projection, so the row takes the ACCOUNT RECORDS and renders one
// figure per account with the label verbatim, on its own line, with the default
// annotation as separate non-wire text beside it. The two shapes this replaced were
// both lies about the wire: a `" (default)"` suffix pasted onto a label puts
// characters inside a figure that the daemon never sent, and a comma-joined string
// makes a label that CONTAINS a comma indistinguishable from two accounts.

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

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
  /**
   * The registry records for this provider, passed through rather than pre-joined.
   *
   * The contract's own shape and not a pair declared here: `displayLabel` and
   * `isDefault` are two members of one record the registry already declares, and a
   * second shape carrying just those two would be that record written twice — free
   * to disagree with it, and with no `accountId` to key a row on.
   */
  readonly accounts: readonly ProviderAccount[];
  readonly action: ProviderActionReading;
  readonly onSignIn: (providerName: string) => void;
  readonly onRecheck: (providerName: string, accountId: ProviderAccountId) => void;
}

/** What the disclosure says where this provider's registry holds nothing at all. */
const NO_ACCOUNTS_NOTE = "None.";

/**
 * How the row says which account this provider resolves to, beside the figure.
 *
 * OUTSIDE the figure and never inside it. `isDefault` is a boolean the registry sent
 * and this sentence is the console's reading of it — mono is the signature that a
 * string came from the wire, and a default marker wearing it would claim the daemon
 * sent these words.
 */
const DEFAULT_ACCOUNT_ANNOTATION = " — the one this provider resolves to";

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
          <dd>
            {props.accounts.length === 0
              ? NO_ACCOUNTS_NOTE
              : props.accounts.map((account) => (
                  <p className="meridian-onboarding__note" key={account.accountId}>
                    <WireFigure value={account.displayLabel} />
                    {account.isDefault ? DEFAULT_ACCOUNT_ANNOTATION : null}
                  </p>
                ))}
          </dd>
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
