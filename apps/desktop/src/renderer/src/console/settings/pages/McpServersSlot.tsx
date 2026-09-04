// The MCP server body's seat on the servers page.
//
// WHAT THIS REPOSITORY BUILDS AND WHAT IT DOES NOT
//
// The page above this seat is chrome: what the operator surface governs, the three
// ways configuration is split, and the one rule that makes this page different from
// every other surface in the console — every control is offered and the daemon's
// typed refusal renders in place. The BODY — the unified inventory, the per-leg
// disclosure, the tool overrides, the configuration form and its write-only fields,
// the live status stream, and the per-binding outcomes a mutation returns — belongs
// to the plan that owns server governance.
//
// WHY A BODY HERE WOULD BE WORSE THAN AN ABSENCE
//
// Two of this page's rules are ones a stand-in body cannot keep. Its status is a
// deterministic aggregate the daemon composes from legs this console cannot see, so
// a body here would have to invent one — and an invented `unknown` is exactly the
// fabricated verdict the trust-unavailable arm exists to prevent. Its controls are
// governed per operation, so a body here would have to decide which are available,
// which is the eligibility no renderer in this console derives.
//
// WHAT THIS FILE MAY NEVER GROW
//
// A configuration value, an environment-variable value, a header value, a token, or
// an authorization URL. Those are the values the operator surface is forbidden to
// render at all, and a seat that carried one would have leaked it before any body
// arrived to decide otherwise.

import type { OwnerSlotProps } from "../../seats/index.js";
import type { OwnerSlotPage, SettingsPageBody } from "../settings-page-registry.js";

/**
 * The seat itself.
 *
 * `body` is `undefined` and this console does not author one. The three contract
 * members are developer-facing and reach no screen.
 */
export const MCP_SERVERS_PAGE_SLOT: OwnerSlotProps<SettingsPageBody> = {
  contract: {
    // Plan-028 owns the MCP governance surface; its page body mounts here.
    owningTask: "Plan-028 (mounted through the settings page frame)",
    mountObligation:
      "the page frame, the section heading, and a SettingsPageContext carrying the console bridge; the body owns the inventory read, the live status subscription, every mutation and its idempotency key, the redacted read-back, and every refusal",
    deleteShellIn: "the Plan-028 page-body task that fills this slot",
  },
  body: undefined,
};

/** The seat and the sentence it renders while nobody has filled it. */
export const MCP_SERVERS_PAGE: OwnerSlotPage = {
  slot: MCP_SERVERS_PAGE_SLOT,
  reservationTitle: "The MCP server page has not been built here yet.",
  reservationDetail:
    "It will list the servers this node may reach, how each one is reported, and what an agent is allowed to call. Nothing has been asked of the daemon for it, and no status below is a reading.",
};
