// One row per provider: what the daemon observed, and what closes the gap.
//
// SIX STATES, EACH WITH ITS OWN RENDER, and the sentences live next door in
// `provider-readiness-copy.ts` as total records over the contract's own unions. A
// provider is reported as set up on the `authenticated` arm and on nothing else — not
// on a billing mode, not on an observed email, not on a credential home that exists.
//
// THE REMEDY IS DISPLAY TEXT AND NEVER AN EXECUTABLE CONTROL. The daemon composes it
// per arm; this renders it. The two remedies whose act is a MUTATING registry verb —
// registering an account, marking one as the default — therefore have no button here
// at all, and the step instead offers a way to the account registry, which is the
// surface that owns those verbs. A button that performed them from this step would be
// a second place the registry is written from.
//
// NO STALENESS BADGE. `observedAt` is rendered as the wire value it is. The contract
// carries no read-path age test and no stale arm, so a badge here would be this
// console inventing a freshness policy and applying it to somebody else's reading.
//
// THE SIGN-IN OUTPUT NEVER REACHES THIS FILE. What the hand-off answers is a
// settlement, and what the row shows afterwards is the projection re-read. The
// provider's own sign-in output may carry OAuth state, PKCE values, or credential
// fields, and nothing in this family has a member it could arrive on.
//
// THE ROW ITSELF IS `ProviderRow.tsx` beside this file. This module owns the step —
// which arm of the reading is on screen, and the two step-level acts — and the row
// owns one provider; each `.tsx` module in this tree declares exactly one component.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { Nothing, RefusalCard } from "../../primitives/index.js";
import { ProviderRow } from "./ProviderRow.js";
import {
  accountsForProvider,
  type ProviderActionReading,
  type ProviderReadinessReading,
} from "./provider-readiness.js";

export interface ProviderReadinessStepProps {
  readonly reading: ProviderReadinessReading;
  readonly actionFor: (providerName: string) => ProviderActionReading;
  readonly onSignIn: (providerName: string) => void;
  readonly onRecheck: (providerName: string, accountId: ProviderAccountId) => void;
  readonly onOpenAccountRegistry: () => void;
  /**
   * Skip this step, where the rail's model says it may be skipped.
   *
   * OPTIONAL, AND THAT IS THE SINGLE SOURCE. `step-model.ts` decides which steps a
   * person may leave unanswered; the walkthrough hands this in from that decision and
   * withholds it otherwise. A boolean prop beside a mandatory handler would be a
   * second place the same rule was written, and the two would eventually disagree.
   */
  readonly onSkip: (() => void) | undefined;
}

export function ProviderReadinessStep(props: ProviderReadinessStepProps): React.JSX.Element {
  return (
    <section className="meridian-onboarding__step" aria-label="Providers">
      <p className="meridian-onboarding__note">
        This step is offered and never required. Nothing below is a permission check — a run
        re-validates whatever this says at the moment it starts.
      </p>
      {renderReading(props)}
      <div className="meridian-onboarding__step-actions">
        <button
          type="button"
          className="meridian-onboarding__act meridian-onboarding__act--secondary"
          onClick={props.onOpenAccountRegistry}
        >
          Open the account registry
        </button>
        {props.onSkip === undefined ? null : (
          <button
            type="button"
            className="meridian-onboarding__act meridian-onboarding__act--secondary"
            onClick={props.onSkip}
          >
            Skip this step
          </button>
        )}
      </div>
    </section>
  );
}

function renderReading(props: ProviderReadinessStepProps): React.ReactNode {
  const { reading } = props;
  switch (reading.kind) {
    case "reading":
      return (
        <Nothing
          kind="not-loaded"
          placement="inline"
          title="Reading what this node can run"
          detail="The answer comes from what was last observed about each account, so nothing is being started to produce it."
        />
      );
    case "unreadable":
      // A block rather than a line: no control produced this, the step's whole
      // question did, and the rows it would have carried are not on screen.
      return <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />;
    case "read":
      return reading.entries.length === 0 ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="No providers are selected on this node."
          detail="Readiness is derived per selected provider, and this node selects none — so there is nothing here to be ready or not."
        />
      ) : (
        <ul className="meridian-onboarding__providers">
          {reading.entries.map((entry) => (
            <ProviderRow
              key={entry.provider}
              entry={entry}
              accountLabels={accountsForProvider(reading.accounts, entry.provider).map(
                (account) => `${account.displayLabel}${account.isDefault ? " (default)" : ""}`,
              )}
              action={props.actionFor(entry.provider)}
              onSignIn={props.onSignIn}
              onRecheck={props.onRecheck}
            />
          ))}
        </ul>
      );
  }
}
