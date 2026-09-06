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

import type { OwnerSlotProps } from "../../../seats/index.js";
import type { OwnerSlotPage, SettingsPageBody } from "../../settings-page-registry.js";

/**
 * The seat itself.
 *
 * `body` is `undefined` and this console does not author one. The three contract
 * members are developer-facing and reach no screen — the reservation below is what
 * a person sees, and it names the feature rather than the work that owes it.
 */
export const PROVIDER_ACCOUNTS_PAGE_SLOT: OwnerSlotProps<SettingsPageBody> = {
  contract: {
    // Plan-029 owns the provider-account registry and its page body; the session
    // cost half of the design's combined page is `CostReceiptPage.tsx`, over
    // Plan-016's committed-spend read.
    owningTask: "Plan-029, with the session figure read through Plan-016",
    mountObligation:
      "the page frame, the section heading, and a SettingsPageContext carrying the console bridge and the rail navigator; the body owns the registry read, the readiness projection, every account control, the write-only token input, and every refusal",
    deleteShellIn: "the Plan-029 page-body task that fills this slot",
  },
  body: undefined,
};

/** The seat and the sentence it renders while nobody has filled it. */
export const PROVIDER_ACCOUNTS_PAGE: OwnerSlotPage = {
  slot: PROVIDER_ACCOUNTS_PAGE_SLOT,
  reservationTitle: "The account registry has not been built here yet.",
  reservationDetail:
    "It will list the provider accounts this node keeps, what the last observation found for each one, and which one a run is admitted against. Nothing has been asked of the daemon for it, and no account below is a reading.",
};
