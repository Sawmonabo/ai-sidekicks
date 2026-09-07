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

import { createElement } from "react";

import { McpShell } from "./shell/index.js";
import type { OwnerSlotProps } from "../../../seats/index.js";
import type { OwnerSlotPage, SettingsPageBody } from "../../settings-page-registry.js";

/**
 * The fixture shell, or nothing.
 *
 * `__SIDEKICKS_CONSOLE_FIXTURES__` is a build-time literal, so a release renderer folds
 * this to `undefined`, the shell subtree is referenced from nothing, and it leaves the
 * bundle — the treatment the fixture bridge, its scenarios, and the pane harness all
 * get. The guard sits HERE rather than at the composition site because whether this
 * seat has a stand-in body at all is this seat's decision, not the settings surface's.
 *
 * AND THE TWO RULES ABOVE STILL HOLD OF IT, which is what makes a shell admissible at
 * this seat rather than merely convenient. It composes no status: the daemon's
 * aggregate arrives on each row and is rendered, and the trust-unavailable arm renders
 * as the absence it is rather than as an invented `unknown`. It decides no
 * availability: every control is offered and the daemon's typed refusal renders under
 * the one that raised it, which is the governing rule rather than a shortcut around it.
 */
const FIXTURE_MCP_SHELL: SettingsPageBody | undefined = __SIDEKICKS_CONSOLE_FIXTURES__
  ? (context) => createElement(McpShell, { bridge: context.bridge })
  : undefined;

/**
 * The seat itself.
 *
 * The three contract members are developer-facing and reach no screen.
 */
export const MCP_SERVERS_PAGE_SLOT: OwnerSlotProps<SettingsPageBody> = {
  contract: {
    // The owning plan is named by its SUBJECT rather than by its number, on the
    // `workflows/owner-slots.ts` precedent: every member here is a runtime string in a
    // shipped module, and this repository keeps governance identifiers in comments —
    // which is where the number belongs and where it is. Plan-028 owns the MCP
    // governance surface; its page body mounts here.
    owningTask:
      "the MCP server configuration and governance plan's own page body, mounted through the settings page frame",
    mountObligation:
      "the page frame, the section heading, and a SettingsPageContext carrying the console bridge; the body owns the inventory read, the live status subscription, every mutation and its idempotency key, the redacted read-back, and every refusal",
    deleteShellIn:
      "the page-body task that fills this slot, which deletes settings/pages/mcp-servers/shell/ whole",
  },
  body: FIXTURE_MCP_SHELL,
};

/** The seat and the sentence it renders while nobody has filled it. */
export const MCP_SERVERS_PAGE: OwnerSlotPage = {
  slot: MCP_SERVERS_PAGE_SLOT,
  reservationTitle: "The MCP server page has not been built here yet.",
  reservationDetail:
    "It will list the servers this node may reach, how each one is reported, and what an agent is allowed to call. Nothing has been asked of the daemon for it, and no status below is a reading.",
};
