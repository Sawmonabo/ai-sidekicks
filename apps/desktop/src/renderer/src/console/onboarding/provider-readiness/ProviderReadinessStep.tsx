// One row per provider: what the daemon observed, and what closes the gap.
//
// SIX STATES, EACH WITH ITS OWN RENDER, and the sentences live next door in
// `provider-readiness-copy.ts` as total records over the contract's own unions. A
// provider is reported as set up on the `authenticated` arm and on nothing else — not
// on a billing mode, not on an observed email, not on a credential home that exists.
//
// THE REMEDY IS DISPLAY TEXT AND NEVER AN EXECUTABLE CONTROL — every arm of it. The
// daemon composes the remedy; this renders it. The two whose act is a MUTATING registry
// verb — registering an account, marking one as the default — are never PERFORMED from
// here, because a button that performed them would be a second place the registry is
// written from and no console route serves either verb anyway; each of those arms still
// gets an action, and it is the way to the surface that owns the verb: the row
// deep-links to the account registry opened FOR its provider, and this step keeps the
// unscoped way there beside **Not now**. One handler serves both — `ProviderRow.tsx`
// says why — and the provider is what tells them apart. The THIRD arm, `sign_in`, has
// no control at all: this step displays the provider's own invocation and never runs it
// on the operator's behalf, so the row renders the invocation and the credential home
// and the person runs it where they can complete it.
//
// AND LEAVING THIS STEP TELLS THE DAEMON NOTHING. The provider group persists nothing:
// no config key, no partial-state entry, no keystore entry, and no event, so the way out
// of it is a local hide and not a recorded skip — see `onDismiss` below.
//
// NO STALENESS BADGE. `observedAt` is rendered as the wire value it is. The contract
// carries no read-path age test and no stale arm, so a badge here would be this
// console inventing a freshness policy and applying it to somebody else's reading.
//
// THE SIGN-IN OUTPUT NEVER REACHES THIS FILE, and now it cannot: nothing here starts a
// sign-in, so there is no process whose output could arrive. That was already the rule
// while a hand-off existed — the provider's own sign-in output may carry OAuth state,
// PKCE values, or credential fields, and nothing in this family has a member it could
// arrive on — and it is a property of the shape rather than a discipline now.
//
// THE ROW ITSELF IS `ProviderRow.tsx` beside this file. This module owns the step —
// which arm of the reading is on screen, and the two step-level acts — and the row
// owns one provider; each `.tsx` module in this tree declares exactly one component.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { Nothing, RefusalCard } from "../../primitives/index.js";
import type { ShellMutationBlock } from "../../store/index.js";
import { ProviderRow } from "./ProviderRow.js";
import {
  accountsForProvider,
  type ProviderActionReading,
  type ProviderReadinessReading,
} from "./provider-readiness-reading.js";

export interface ProviderReadinessStepProps {
  readonly reading: ProviderReadinessReading;
  readonly actionFor: (providerName: string) => ProviderActionReading;
  readonly onRecheck: (providerName: string, accountId: ProviderAccountId) => void;
  /**
   * Why a re-check may not be put right now, passed straight through to every row.
   *
   * ONE VALUE FOR THE WHOLE STEP because the cause is a fact about the window and not
   * about a provider: the supervisor either takes a mutating call or it does not, and
   * a per-row derivation would be that one answer computed twice.
   */
  readonly recheckBlock: ShellMutationBlock | undefined;
  /**
   * Open the account registry, scoped to a provider where the caller names one.
   *
   * ONE HANDLER FOR TWO CONTROLS. The step's own button is the unscoped way there and
   * passes `undefined`; a row's registry action names its provider, and the page it
   * lands on says which one it was opened for. Two handlers would be two places the
   * destination section is named, free to disagree the first time one moved.
   */
  readonly onOpenAccountRegistry: (providerName: string | undefined) => void;
  /**
   * **Not now** — put this step away, where there is a way out to put it away into.
   *
   * A LOCAL EXIT AND NEVER A RECORDED SKIP. This group persists nothing — no config
   * key, no partial-state entry, no keystore entry, and no event — so leaving the step
   * tells the daemon nothing: this handler closes the walkthrough and writes nowhere,
   * on the invitation shelf's **Not now** precedent. It used to dispatch
   * `onboarding.stepSkip`, which recorded the provider step in the daemon's own
   * completed set — a second record of a step whose truth lives in the account
   * registry, and one that stayed true after every account was signed out.
   *
   * OPTIONAL, AND THAT IS THE SINGLE SOURCE — twice over. `step-model.ts` decides
   * which steps a person may leave unanswered, and the overlay decides whether this
   * activation may be closed at all; the walkthrough hands this in only where both
   * say yes and withholds it otherwise. A boolean prop beside a mandatory handler
   * would be a second place either rule was written.
   */
  readonly onDismiss: (() => void) | undefined;
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
          onClick={() => {
            props.onOpenAccountRegistry(undefined);
          }}
        >
          Open the account registry
        </button>
        {props.onDismiss === undefined ? null : (
          <button
            type="button"
            className="meridian-onboarding__act meridian-onboarding__act--secondary"
            onClick={props.onDismiss}
          >
            Not now
          </button>
        )}
      </div>
      {props.onDismiss === undefined ? null : (
        <p className="meridian-onboarding__note meridian-onboarding__note--quiet">
          Not now simply puts this away. Nothing is recorded — which providers this node can run
          lives in the account registry, and a run re-reads it when it starts.
        </p>
      )}
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
              // The records, straight through. Composing a display string here would
              // put a label the daemon sent into a value nothing downstream could tell
              // back apart from the console's own words — see `ProviderRow.tsx`.
              accounts={accountsForProvider(reading.accounts, entry.provider)}
              action={props.actionFor(entry.provider)}
              onRecheck={props.onRecheck}
              recheckBlock={props.recheckBlock}
              onOpenAccountRegistry={props.onOpenAccountRegistry}
            />
          ))}
        </ul>
      );
  }
}
