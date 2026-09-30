import type { ReactNode } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import type { McpServerBindingRef, McpServerInventoryEntry } from "@ai-sidekicks/contracts";
import { ConfigReadBack } from "./ConfigReadBack.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";
import { toneForServerStatus } from "../server-status-tone.js";
import { ToolOverrideList } from "./ToolOverrideList.js";
import type { McpMutationOutcome } from "../mcp-mutation.js";

/**
 * One inventory row: the binding's identity, what is known about it, and the two controls this
 * fixture body sends.
 *
 * The identity is the scope-qualified tuple, never the name: two same-named servers in two
 * scopes are two bindings, so provider, scope and scope reference are all on screen. Every
 * control is offered and none is eligibility-gated; a control disables only while its own call
 * is in flight. The exception is structural: when the trust store is unreachable, `trusted`,
 * `configHash` and the overrides are absent from the wire, and the trust control is withheld on
 * that row because there is no current value for a toggle to move away from.
 */
export function ServerRow(props: {
  readonly entry: McpServerInventoryEntry;
  readonly outcome: McpMutationOutcome;
  readonly pending: boolean;
  readonly onSetEnabled: (binding: McpServerBindingRef, enabled: boolean) => void;
  readonly onSetTrust: (binding: McpServerBindingRef, trusted: boolean) => void;
}): ReactNode {
  const { entry, outcome, pending, onSetEnabled, onSetTrust } = props;
  const binding = bindingOf(entry);
  return (
    <li className="meridian-mcp__row">
      <div className="meridian-mcp__row-identity">
        <WireFigure value={entry.serverName} />
        <Chip label={entry.provider} mono />
        <Chip label={entry.scope} mono />
        <Chip label={entry.status} mono tone={toneForServerStatus(entry.status)} />
        {entry.requiredServer === true ? <Chip label="required" tone="attention" /> : null}
        {entry.effectiveInRuns ? null : (
          <Chip label="not effective in runs" tone="attention" glyph="alert" />
        )}
      </div>

      <div className="meridian-mcp__row-provenance">
        {binding.scope === "user" ? (
          <span className="meridian-settings-page__aside">Declared for this user.</span>
        ) : (
          <>
            <span className="meridian-settings-page__aside">Declared at</span>
            <WireFigure value={binding.scopeRef} />
          </>
        )}
        {entry.scopeRefDigest === undefined ? null : <WireFigure value={entry.scopeRefDigest} />}
        {entry.observedAt === undefined ? (
          <span className="meridian-settings-page__aside">Never observed.</span>
        ) : (
          <>
            <span className="meridian-settings-page__aside">Observed</span>
            <DerivedFigure text={formatDateTime(entry.observedAt)} />
          </>
        )}
      </div>

      <ConfigReadBack config={entry.config} />

      <div className="meridian-mcp__row-block">
        <h4 className="meridian-mcp__row-block-title">Live legs</h4>
        <ServerLegs legs={entry.legs} />
      </div>

      <div className="meridian-mcp__row-block">
        <h4 className="meridian-mcp__row-block-title">Tool overrides</h4>
        {entry.trustUnavailable === true ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="The trust store could not be read."
            detail="Whether this binding is trusted, what its configuration hashes to, and which tools carry overrides are all unknown right now — not false, and not empty."
          />
        ) : (
          <ToolOverrideList overrides={entry.toolOverrides} />
        )}
      </div>

      <div className="meridian-mcp__row-actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          disabled={pending}
          onClick={() => {
            onSetEnabled(binding, entry.enabled !== true);
          }}
        >
          {entry.enabled === true ? "Disable this binding" : "Enable this binding"}
        </button>
        {entry.trustUnavailable === true ? (
          <span className="meridian-settings-page__aside">
            The trust control is withheld while the trust store cannot be read: there is no current
            value for it to move away from.
          </span>
        ) : (
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            disabled={pending}
            onClick={() => {
              onSetTrust(binding, !entry.trusted);
            }}
          >
            {entry.trusted ? "Withdraw trust" : "Grant trust"}
          </button>
        )}
      </div>

      <MutationOutcomeLine outcome={outcome} />
    </li>
  );
}

/**
 * The binding identity carried inside one inventory entry.
 *
 * Rebuilt per arm rather than spread, so the discriminated union stays discriminated and no
 * cast is needed to keep a `scopeRef` off the `user` arm.
 */
function bindingOf(entry: McpServerInventoryEntry): McpServerBindingRef {
  if (entry.scope === "user") {
    return { provider: entry.provider, scope: "user", serverName: entry.serverName };
  }
  if (entry.scope === "local") {
    return {
      provider: entry.provider,
      scope: "local",
      scopeRef: entry.scopeRef,
      serverName: entry.serverName,
    };
  }
  return {
    provider: entry.provider,
    scope: "project",
    scopeRef: entry.scopeRef,
    serverName: entry.serverName,
  };
}
