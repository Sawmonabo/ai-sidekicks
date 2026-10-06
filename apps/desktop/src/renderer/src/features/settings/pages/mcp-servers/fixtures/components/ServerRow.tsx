import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { MCP_SERVER_STATUS_WORDS } from "#renderer/lib/mcp-server-status-words.js";
import { PROVIDER_LABELS } from "#renderer/lib/provider-labels.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import type {
  McpServerBindingRef,
  McpServerInventoryEntry,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/mcp";
import { ConfigReadBack } from "./ConfigReadBack.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";
import { toneForServerStatus } from "../server-status-tone.js";
import { ToolOverrideList } from "./ToolOverrideList.js";
import type { McpMutationOutcome } from "../mcp-mutation.js";

// Where a binding a person writes applies, in the words the add form offers for each scope.
const WHERE_IT_APPLIES: Readonly<Record<McpWritableBindingRef["scope"], string>> = {
  user: "On this machine, in every project",
  project: "In this project, saved with the repository",
  local: "In this project, on this machine only",
};

/**
 * One inventory row: the binding's identity, what is known about it, and the control this
 * fixture body sends.
 *
 * The identity is the scope-qualified tuple, never the name: two same-named servers in two
 * scopes are two bindings, so provider, where it applies and its project or plugin are all on
 * screen. The control is offered and not eligibility-gated; it disables only while its own call
 * is in flight. When the binding store is unreachable the overrides are absent from the wire, and
 * the row says so.
 */
export function ServerRow(props: {
  readonly entry: McpServerInventoryEntry;
  readonly outcome: McpMutationOutcome;
  readonly pending: boolean;
  readonly onSetEnabled: (binding: McpServerBindingRef, enabled: boolean) => void;
}): ReactNode {
  const { entry, outcome, pending, onSetEnabled } = props;
  const binding = bindingOf(entry);
  return (
    <li className="meridian-mcp__row">
      <div className="meridian-mcp__row-identity">
        <WireFigure value={entry.serverName} />
        <Chip label={PROVIDER_LABELS[entry.provider]} />
        <Chip
          label={MCP_SERVER_STATUS_WORDS[entry.status]}
          tone={toneForServerStatus(entry.status)}
        />
        {entry.requiredServer === true ? <Chip label="required" tone="attention" /> : null}
      </div>

      <div className="meridian-mcp__row-provenance">
        <span className="meridian-settings-page__aside">
          {binding.scope === "plugin" ? "Declared by plugin" : WHERE_IT_APPLIES[binding.scope]}
        </span>
        {binding.scope === "user" ? null : <WireFigure value={binding.scopeRef} />}
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
        {entry.bindingStoreUnavailable === true ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="The binding store could not be read."
            detail="Which tools carry overrides is unknown right now — not false, and not empty."
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
  return entry.scope === "user"
    ? { provider: entry.provider, scope: "user", serverName: entry.serverName }
    : {
        provider: entry.provider,
        scope: entry.scope,
        scopeRef: entry.scopeRef,
        serverName: entry.serverName,
      };
}
