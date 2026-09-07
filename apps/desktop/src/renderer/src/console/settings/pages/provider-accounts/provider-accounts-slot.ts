// The provider-account body's seat on the accounts page.
//
// WHAT THIS REPOSITORY BUILDS AND WHAT IT DOES NOT
//
// The page above this seat is chrome: the lede, the closed vocabularies a row will
// speak, the handoff the sign-in flow performs, and the discipline the body is held
// to. The BODY — the registry list, the detail pane, the per-limit quota table, the
// registration form and its write-only field, the brokered sign-in card, and every
// refusal any of those raise — belongs to the plan that owns the account registry,
// and a body authored here would be a second authority on which account a run is
// admitted against.
//
// WHY THE SEAT TAKES THE PAGE CONTEXT AND NOTHING ELSE
//
// A settings page is handed a bridge, a rail navigator, and the session the window
// has open. The account registry is node-local and session-independent, so the body
// needs the bridge and the navigator — the `choose_default` remedy sends a person
// to a candidate list, which is a rail move — and nothing this page could add. A
// seat that also carried, say, a selected account id would be this console deciding
// the body's selection model, which is the body's decision and not the mount's.
//
// WHAT THIS FILE MAY NEVER GROW
//
// A field, a form, a read, or a figure. Every axis the design puts on this page is
// an account-registry axis, and each one is a value the daemon observed rather than
// a value this console may compose: the health reading, the credential generation,
// the re-login horizon, and the quota rows all have exactly one producer.

import { createElement } from "react";

import { AccountsShell } from "./shell/index.js";
import type { OwnerSlotProps } from "../../../seats/index.js";
import type { OwnerSlotPage, SettingsPageBody } from "../../settings-page-registry.js";

/**
 * The fixture shell, or nothing.
 *
 * `__SIDEKICKS_CONSOLE_FIXTURES__` is a build-time literal, so a release renderer
 * folds this to `undefined`, the shell subtree is referenced from nothing, and it
 * leaves the bundle — the treatment the fixture bridge, its scenarios, and the pane
 * harness all get. The guard sits HERE rather than at the composition site because
 * whether this seat has a stand-in body at all is this seat's decision, not the
 * settings surface's.
 *
 * WHAT THE SHELL IS ALLOWED TO BE, given the paragraphs above. It reads the same
 * registered wire the owning body will read and renders what came back; it derives
 * no eligibility, invents no health verdict, and composes no remedy. The rule the
 * header states — no field, form, read, or figure grows in THIS FILE — is what keeps
 * the seat itself honest while a stand-in stands in a directory that is deleted whole.
 */
const FIXTURE_ACCOUNTS_SHELL: SettingsPageBody | undefined = __SIDEKICKS_CONSOLE_FIXTURES__
  ? (context) => createElement(AccountsShell, { bridge: context.bridge })
  : undefined;

/**
 * The seat itself.
 *
 * The three contract members are developer-facing and reach no screen — the
 * reservation below is what a person sees where no body is mounted, and it names the
 * feature rather than the work that owes it.
 */
export const PROVIDER_ACCOUNTS_PAGE_SLOT: OwnerSlotProps<SettingsPageBody> = {
  contract: {
    // The owning plan is named by its SUBJECT rather than by its number, on the
    // `workflows/owner-slots.ts` precedent: every member here is a runtime string in a
    // shipped module, and this repository keeps governance identifiers in comments —
    // which is where the numbers belong and where they are. Plan-029 owns the
    // provider-account registry and its page body; the session cost half of the
    // design's combined page is `CostReceiptPage.tsx`, over Plan-016's committed-spend
    // read.
    owningTask:
      "the provider-accounts and credential-homes plan's own page body, with the session figure read through the orchestration plan's committed-spend read",
    mountObligation:
      "the page frame, the section heading, and a SettingsPageContext carrying the console bridge and the rail navigator; the body owns the registry read, the readiness projection, every account control, the write-only token input, and every refusal",
    deleteShellIn:
      "the page-body task that fills this slot, which deletes settings/pages/provider-accounts/shell/ whole",
  },
  body: FIXTURE_ACCOUNTS_SHELL,
};

/** The seat and the sentence it renders while nobody has filled it. */
export const PROVIDER_ACCOUNTS_PAGE: OwnerSlotPage = {
  slot: PROVIDER_ACCOUNTS_PAGE_SLOT,
  reservationTitle: "The account registry has not been built here yet.",
  reservationDetail:
    "It will list the provider accounts this node keeps, what the last observation found for each one, and which one a run is admitted against. Nothing has been asked of the daemon for it, and no account below is a reading.",
};
