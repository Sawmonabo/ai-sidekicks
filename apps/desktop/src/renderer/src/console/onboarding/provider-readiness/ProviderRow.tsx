// One provider's row: its state, its remedy, its one act, and what was observed.
//
// SPLIT FROM `ProviderReadinessStep.tsx`, which owns the step. This module owns one
// provider, and the whole of what the console is allowed to say about it: the state
// label and its sentence, the remedy as TEXT, a re-check only where an account
// actually resolved, and a disclosure carrying the wire figures verbatim.
//
// THE REMEDY IS NEVER EXECUTED HERE — the SIGN-IN ARM INCLUDED, which is the one this
// row used to run. The step hands the operator the provider's own first-party flow with
// the remedy named — which provider, which account, the invocation, and the home — and
// **displays** that invocation rather than running it on the operator's behalf. The
// brokered login lives on the provider-management surface, and `providerAccount.login`
// and `loginCancel` are excluded from this step's calls, so that a first run never
// depends on a brokered process the operator did not ask for. So the four things the
// remedy names are RENDERED, as the wire figures they are, and no control on this row
// starts a login. What decides whether it worked is the re-check beside them, because
// the probe defines success and a sign-in process's exit does not.
//
// AND `register` / `choose_default` ARE NOT EXECUTED EITHER, for a second reason. They
// are mutating registry verbs the account registry owns, and no console route serves
// either — `bridge/daemon/daemon-reply-registry.ts` carries `providerAccount.list` and
// `providerAccount.probe` and nothing else — so a button here that performed one would
// be a second place that registry is written from AND a control with nothing to call.
// What those two arms get instead is a DEEP LINK: the registry page, opened for this
// provider, which is the surface that owns the verb.
//
// A LINK PER ROW AND NOT ONLY THE STEP'S ONE BUTTON. The step already offers the
// registry, unscoped; a person reading a row about one provider and pressing a control
// beneath it arrives on a page that says which provider they came for and what the
// first run against it will do. The step's button is the way to the registry, and this
// is the way to the registry ABOUT THIS ROW.
//
// NO STALENESS BADGE. `observedAt` is rendered as the wire value it is — the contract
// carries no read-path age test and no stale arm, so a badge would be this console
// inventing a freshness policy and applying it to somebody else's reading.
//
// AND THE RE-CHECK CLOSES WHEN THE SUPERVISOR CANNOT BE WRITTEN TO, alone among the
// two controls. It is the one act on this row that dispatches anything at all, so the
// block arrives resolved for exactly that method rather than as a fact about the row:
// the registry link leaves for another surface, and every figure above it came from a
// read that survives the same outage. The row never asks which states block a write —
// the model asked the store, and this renders the answer.
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
import type { ShellMutationBlock } from "../../store/index.js";
import {
  OBSERVED_AT_UNSET_NOTE,
  READINESS_STATE_LABELS,
  READINESS_STATE_NOTES,
  remedyHeadline,
  remedyRegistryActionLabel,
} from "./provider-readiness-copy.js";
import type { ProviderActionReading } from "./provider-readiness-reading.js";

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
  readonly onRecheck: (providerName: string, accountId: ProviderAccountId) => void;
  /**
   * Open the account registry, scoped to the provider the caller names.
   *
   * The SAME handler the step's own unscoped button takes, given a provider here and
   * nothing there. One destination reached two ways rather than two handlers that
   * would each have to be kept pointing at the same section.
   */
  readonly onOpenAccountRegistry: (providerName: string) => void;
  /**
   * Why a re-check may not be put right now, or `undefined` while nothing closes it.
   *
   * ONE ACT AND NOT THE ROW, because the store's seam answers per METHOD: the re-check
   * dispatches `providerAccount.probe`, which a stopped supervisor blocks, while the
   * reading behind every figure on this row is `providerAccount.list`, which it does
   * not — and the registry link leaves for another surface rather than dispatching at
   * all. A row-wide disablement would be this surface widening a rule the store states
   * narrowly.
   */
  readonly recheckBlock: ShellMutationBlock | undefined;
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

/**
 * What the row says beneath a sign-in remedy's figures, and it is a promise it keeps.
 *
 * The figures above it are the whole remedy and this sentence is what the console is
 * doing about them: nothing. It is here rather than in `provider-readiness-copy.ts`
 * because that module's tables are TOTAL over the contract's own unions — a sentence
 * for one arm about this surface's own conduct is not a reading of the wire.
 */
const SIGN_IN_IS_NOT_RUN_HERE_NOTE =
  "Run that yourself where you can complete it — this console never starts a provider's sign-in and never reads what it writes. Then use Check again: the probe is what decides whether it worked, never the sign-in's own exit.";

export function ProviderRow(props: ProviderRowProps): React.JSX.Element {
  const { entry } = props;
  const { resolvedAccountId } = entry;
  const isRechecking = props.action.kind === "rechecking";
  // `undefined` on the one arm whose remedy is neither a registry verb nor anything
  // this console performs: a sign-in is displayed in full above, so a control here
  // would promise an act that no surface in this build carries out.
  const registryActionLabel =
    entry.remedy === undefined ? undefined : remedyRegistryActionLabel(entry.remedy);
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
      {/* THE HANDOFF ITSELF, and the whole of it: the invocation the daemon composed
          and the credential home it authenticates into, both verbatim. On the row
          rather than behind the disclosure below, because this is what a person acts
          on — a remedy a person has to go looking for is a remedy that was named and
          not handed over. */}
      {entry.remedy?.kind === "sign_in" ? (
        <>
          <dl className="meridian-onboarding__figures">
            <dt>Sign-in this remedy names</dt>
            <dd>
              <WireFigure value={entry.remedy.signInInvocation} />
            </dd>
            <dt>Credential home it authenticates into</dt>
            <dd>
              <WireFigure value={entry.remedy.credentialHomePath} />
            </dd>
          </dl>
          <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
            {SIGN_IN_IS_NOT_RUN_HERE_NOTE}
          </p>
        </>
      ) : null}
      <div className="meridian-onboarding__step-actions">
        {registryActionLabel === undefined ? null : (
          // NOT disabled while a re-check is out, unlike the control beside it. That
          // one dispatches a call and a second press would be a second call; this one
          // leaves for another surface, which a person may always do.
          <button
            type="button"
            className="meridian-onboarding__act meridian-onboarding__act--secondary"
            onClick={() => {
              props.onOpenAccountRegistry(entry.provider);
            }}
          >
            {registryActionLabel}
          </button>
        )}
        {resolvedAccountId === undefined ? null : (
          <button
            type="button"
            className="meridian-onboarding__act meridian-onboarding__act--secondary"
            onClick={() => {
              props.onRecheck(entry.provider, resolvedAccountId);
            }}
            disabled={isRechecking || props.recheckBlock !== undefined}
            title={props.recheckBlock?.detail}
          >
            Check again
          </button>
        )}
      </div>
      {/* DISABLED WITH ITS CAUSE BESIDE IT, never hidden: a control that disappears
          while the runtime is away reads as a control this build does not have, and a
          disabled one with its sentence off screen reads as one that quietly stopped
          working. Through the console's one row-scoped refusal shape, which is how the
          palette renders the same block — the two members ARE a code and a sentence,
          so nothing here composes a second shape for "the shell says no". */}
      {props.recheckBlock === undefined ? null : (
        <InlineRefusal code={props.recheckBlock.code} detail={props.recheckBlock.detail} />
      )}
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
          {/* The sign-in remedy's own two figures are NOT repeated here. They are on
              the row above, where a person acts on them, and one wire value with two
              renderings is one value a reader has to reconcile. */}
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
