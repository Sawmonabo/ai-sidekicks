import type { ReactNode } from "react";

import {
  Chip,
  DerivedFigure,
  Nothing,
  WireFigure,
  formatDateTime,
} from "../../../../primitives/index.js";
import type { GrowthMcpBindingRef, GrowthMcpInventoryEntry } from "../../../../bridge/index.js";
import { ConfigReadBack } from "./ConfigReadBack.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";
import { toneForServerStatus } from "./server-status-tone.js";
import { ToolOverrideList } from "./ToolOverrideList.js";
import type { McpMutationOutcome } from "./mcp-mutation.js";

/**
 * One inventory row: the binding's identity, what is known about it, and the two
 * controls this shell sends.
 *
 * THE IDENTITY IS THE SCOPE-QUALIFIED TUPLE AND NEVER THE NAME. Two same-named servers
 * in two scopes are two bindings, and a row keyed on the name would collapse them —
 * putting one row's status, one row's overrides, and one row's mutation outcome onto
 * the other. The provider, the scope, and the scope reference are all on screen for
 * exactly that reason.
 *
 * EVERY CONTROL IS OFFERED AND NONE IS ELIGIBILITY-GATED. The governing surface says
 * so in terms: eligibility is not projected at all, no field reports it, and the
 * daemon's typed refusal renders in place. So this row disables a control only while
 * its own call is in flight — which is about this press and not about permission — and
 * a refusal lands under the control that raised it.
 *
 * EXCEPT WHERE THE TRUST STORE IS UNREACHABLE, WHICH IS STRUCTURAL. On that arm
 * `trusted`, `configHash`, and the overrides are ABSENT from the wire rather than
 * false, and the trust control is withheld on that row alone — not because this
 * console decided the operator may not press it, but because there is no current value
 * for a toggle to move away from, and a toggle rendered against nothing would be
 * asserting one.
 */
export function ServerRow(props: {
  readonly entry: GrowthMcpInventoryEntry;
  readonly outcome: McpMutationOutcome;
  readonly pending: boolean;
  readonly onSetEnabled: (binding: GrowthMcpBindingRef, enabled: boolean) => void;
  readonly onSetTrust: (binding: GrowthMcpBindingRef, trusted: boolean) => void;
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
          className="meridian-settings-page__action"
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
            className="meridian-settings-page__action"
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
 * Rebuilt per arm rather than spread off the entry, so the discriminated union stays
 * discriminated: a spread would widen `scope` back to its union and produce a value
 * the mutation signature cannot take without a cast — and a cast here would switch off
 * exactly the checking that keeps `(codex, local)` unrepresentable.
 */
function bindingOf(entry: GrowthMcpInventoryEntry): GrowthMcpBindingRef {
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
