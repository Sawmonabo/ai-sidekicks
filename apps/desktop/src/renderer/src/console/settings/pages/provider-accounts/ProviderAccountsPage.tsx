// The accounts page: which provider accounts this node keeps, and what has to be
// true before a run is admitted against one.
//
// `Spec-023 §Console Design (Meridian)` §Provider accounts puts a registry list and
// a detail pane here, and §Sign-in, token registration, and the readiness handoff
// puts the flow that gets an account from unusable to usable beside it. Both of
// those are the account plane's BODY, and this repository authors none of it — the
// page frame, the vocabulary, and the discipline are here, and the body arrives
// through `provider-accounts-slot.ts`.
//
// WHY THE VOCABULARY IS RENDERED AND THE ROWS ARE NOT
//
// The registry read is not a wire this console has. Its payload types are, which is
// a real difference and not a technicality: the closed sets a row will speak — how
// an account is billed, what the last observation found, and what run admission
// will answer — are declared once in `@ai-sidekicks/contracts` and imported here,
// so the page can say what it will show without inventing a single row of it. A
// seventh readiness arm added upstream is a compile error in this file rather than
// a term that quietly stops being explained.
//
// What is deliberately NOT rendered is the mapping from a readiness state to the
// action that closes it. That mapping is the daemon's, it travels on the reply, and
// a copy of it here would be this console composing a remedy — which the design
// forbids in terms, because the remedy carries a credential-home path and a
// first-party sign-in command that only the node that owns the home can name.

import {
  BILLING_MODES,
  PROVIDER_ACCOUNT_HEALTH_STATES,
  PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS,
  PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES,
  PROVIDER_NAMES,
  PROVIDER_READINESS_STATES,
  type BillingMode,
  type ProviderAccountHealthState,
  type ProviderAccountUsageWindowSource,
  type ProviderReadinessState,
} from "@ai-sidekicks/contracts";
import type { ReactNode } from "react";

import { Chip, WireFigure } from "../../../primitives/index.js";
import { PROVIDER_ACCOUNTS_PAGE } from "./provider-accounts-slot.js";
import {
  renderOwnerSlotPage,
  type SettingsPageContext,
  type SettingsPageRegistry,
} from "../../settings-page-registry.js";
import { WireVocabulary } from "./WireVocabulary.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-accounts";

/**
 * What each billing mode means beside a money figure.
 *
 * TOTAL over the contract's own union, so a fourth mode cannot land upstream and
 * leave this page rendering a term it never explains. `unknown` is the honest
 * absence and is never worded as a synonym for metered: it labels a figure the
 * daemon could not attribute, and calling it billed would attach a spend claim
 * nobody made.
 */
const BILLING_MODE_MEANINGS: Readonly<Record<BillingMode, string>> = {
  subscription: "Usage is included in a plan. A figure beside it is not currency owed.",
  metered: "Usage is billed per unit against this account.",
  unknown: "How this account is charged was not established. The figure carries no claim.",
};

/** What the last stored observation found. Never a claim about right now. */
const HEALTH_STATE_MEANINGS: Readonly<Record<ProviderAccountHealthState, string>> = {
  authenticated: "The last observation found this credential home signed in.",
  reauth_required: "The provider asked for a fresh sign-in on this home.",
  home_missing: "The credential home the registry expects was not there.",
  indeterminate: "Nothing decided. Treated as not signed in, which is not the same as a failure.",
};

/**
 * The answer run admission will reach, pre-computed. It authorizes nothing.
 *
 * The onboarding walkthrough holds a second table over this same closed union, and
 * the two are kept apart on REGISTER: these are an operator's reference and say what
 * admission WOULD do; those are a first-run step and say what is true of the provider
 * now. The union itself has one home in `packages/contracts`, so an arm added there is
 * a compile error in both.
 */
const READINESS_STATE_MEANINGS: Readonly<Record<ProviderReadinessState, string>> = {
  authenticated: "A run would be admitted against the account this resolved to.",
  reauth_required: "An account resolved, and its home needs signing in again.",
  home_missing: "An account resolved, and its credential home is not there.",
  indeterminate: "An account resolved, and no observation has decided about it.",
  no_account: "No account is registered for this provider at all.",
  no_default: "Accounts are registered and none of them is the provider's default.",
};

/** Where a quota reading came from. Never the background observer, which reads none. */
const QUOTA_SOURCE_MEANINGS: Readonly<Record<ProviderAccountUsageWindowSource, string>> = {
  probe: "A deliberate re-observation of this account, asked for from here.",
  run: "Real traffic. The provider reported the window while a run was using it.",
};

export function ProviderAccountsPage(props: { readonly context: SettingsPageContext }): ReactNode {
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        A provider account is one credential home this machine keeps, and a run is admitted against
        exactly one of them. The registry is node-local: it never leaves this machine, it never
        totals across sessions, and every reading on it was stored earlier rather than obtained by
        starting a provider now.
      </p>

      <div className="meridian-settings-page__chips">
        {PROVIDER_NAMES.map((provider) => (
          <Chip key={provider} tone="neutral" label={provider} mono glyph="agent" />
        ))}
        <Chip tone="neutral" label="Node-local registry" glyph="dot" />
      </div>

      <WireVocabulary
        label="What an account is charged as"
        terms={BILLING_MODES}
        meanings={BILLING_MODE_MEANINGS}
      />

      <WireVocabulary
        label="What the last observation found"
        terms={PROVIDER_ACCOUNT_HEALTH_STATES}
        meanings={HEALTH_STATE_MEANINGS}
      />

      <WireVocabulary
        label="What run admission will answer"
        terms={PROVIDER_READINESS_STATES}
        meanings={READINESS_STATE_MEANINGS}
      />

      <WireVocabulary
        label="Where a quota reading came from"
        terms={PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES}
        meanings={QUOTA_SOURCE_MEANINGS}
        note="One row per limit an account has, and for each limit the newest observation is the one that stands."
      />

      <section className="meridian-settings-page__block" aria-label="Signing in">
        <h3 className="meridian-settings-page__block-title">Signing in</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Sign-in is brokered, never held here. The daemon starts the provider&rsquo;s own
            first-party login against one credential home and streams back the address to visit and
            the code to type; this window reads nothing that flow writes and stores nothing it
            produces.
          </p>
          <p>
            What is inside a credential home never reaches this screen. The one path shown anywhere
            is the display-only one the daemon puts on the action it composed, and a completed
            sign-in is the end of a flow rather than a verdict — readiness is read again afterwards.
          </p>
          <p>
            Which action closes a given state — register one, choose a default, or sign in — is
            composed by the daemon when the registry is read and travels beside the state. This page
            derives none of it, because the action names a credential home and a first-party command
            that only the machine holding them can name.
          </p>
          <p>
            A non-interactive credential is submitted on one input that appears on no reply. Its
            wire member is{" "}
            {PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS.map((member) => (
              <WireFigure key={member} value={member} />
            ))}
            , and it is write-only in both directions: it is never echoed back, never held in state
            this window could serialize, and never rendered.
          </p>
          <p>
            Readiness is advisory. It is a stored observation rather than a live check, it never
            blocks a run, and admission re-validates on its own — so a state here is a reading and
            never a verdict.
          </p>
        </div>
      </section>

      {renderOwnerSlotPage(PROVIDER_ACCOUNTS_PAGE, props.context)}
    </div>
  );
}

/** Claim the accounts section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerProviderAccountsPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "accounts",
    owner: OWNER,
    label: "Provider accounts",
    keywords: [
      "provider",
      "credentials",
      "sign in",
      "login",
      "billing",
      "quota",
      "rate limit",
      "default account",
      "readiness",
    ],
    render: (context) => <ProviderAccountsPage context={context} />,
  });
}
