// The MCP servers page: what this machine offers to runs, governed from one place.
//
// `Spec-023 §Console Design (Meridian)` §MCP servers puts the unified inventory,
// the per-leg disclosure, the tool overrides, and the live status stream here. All
// of that is the governance plane's BODY, which this repository does not author —
// what is here is the page frame and the three rules the body inherits from it.
//
// THE ONE PLACE THIS CONSOLE OFFERS A CONTROL IT MAY NOT BE ALLOWED TO USE
//
// Everywhere else in Meridian an unavailable control is absent rather than greyed,
// because a control a person cannot use is a question the console answered for
// them. This page is the deliberate exception: every control is offered and the
// daemon's typed refusal renders on the row and the control that produced it. The
// reason is that governance eligibility is not a projection of anything on the
// wire — it is decided per operation, per server, and per scope, and a renderer
// that guessed would be a second authority on a decision recovery depends on.
//
// WHAT THE PAGE IS FORBIDDEN TO RENDER, AND WHY THE FRAME SAYS SO
//
// Configuration splits three ways here: input a person supplies, of which the
// credential-bearing parts are write-only; read-back, which is exactly the redacted
// view the daemon serves and never a reconstruction; and values the daemon does not
// serve, which are rendered nowhere. Saying that in the frame rather than only in a
// review comment is what makes it checkable — the body lands into a page that has
// already declared it, and the co-located test holds the declaration.

import type { ReactNode } from "react";

import { Chip } from "../../../primitives/index.js";
import { MCP_SERVERS_PAGE } from "./McpServersSlot.js";
import {
  renderOwnerSlotPage,
  type SettingsPageContext,
  type SettingsPageRegistry,
} from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-mcp";

/**
 * What this page may never put on screen.
 *
 * A list rather than a paragraph because each line is a separate prohibition with a
 * separate way of being broken, and a reader checking the body against them should
 * be able to check them one at a time.
 */
const NON_DISCLOSURE_RULES: readonly string[] = [
  "No configuration value, no environment-variable value, no header value, and no credential.",
  "Read-back is exactly the redacted view the daemon serves — never a value reassembled from what was typed.",
  "A value the daemon does not serve is rendered nowhere, not even as a placeholder saying it exists.",
  "An authorization address belongs to the flow that is running and is never kept after it ends.",
];

export function McpServersPage(props: { readonly context: SettingsPageContext }): ReactNode {
  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        A server here is a tool source this machine offers to runs. The page governs which ones
        exist, which are enabled, how far each one is trusted, and which of its tools an agent may
        call — one row per server, with its legs and overrides one disclosure away.
      </p>

      <div className="meridian-settings-page__chips">
        <Chip tone="neutral" label="Status is pushed, never polled" glyph="dot" />
        <Chip tone="neutral" label="One row per server" glyph="workspace" />
        <Chip tone="attention" label="Every control offered; the daemon refuses" glyph="alert" />
      </div>

      <section className="meridian-settings-page__block" aria-label="What this page never shows">
        <h3 className="meridian-settings-page__block-title">What this page never shows</h3>
        <ul className="meridian-settings-page__list">
          {NON_DISCLOSURE_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>

      <section className="meridian-settings-page__block" aria-label="Who decides">
        <h3 className="meridian-settings-page__block-title">Who decides</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Nothing on this page decides whether an operation is allowed. Every control is offered,
            the attempt is made, and the daemon&rsquo;s answer renders where it was asked — on the
            row and the control that produced it, in the daemon&rsquo;s own words.
          </p>
          <p>
            The page holds no state of its own either. A status arriving for one server is applied
            to that server&rsquo;s row rather than triggering a re-read of everything, and a server
            whose trust could not be established renders that absence as an absence — never as a
            status this console invented to fill the column.
          </p>
        </div>
      </section>

      {renderOwnerSlotPage(MCP_SERVERS_PAGE, props.context)}
    </div>
  );
}

/** Claim the MCP servers section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerMcpServersPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "mcp-servers",
    owner: OWNER,
    label: "MCP servers",
    keywords: [
      "tools",
      "servers",
      "model context protocol",
      "governance",
      "trust",
      "overrides",
      "reconnect",
      "authorize",
    ],
    render: (context) => <McpServersPage context={context} />,
  });
}
