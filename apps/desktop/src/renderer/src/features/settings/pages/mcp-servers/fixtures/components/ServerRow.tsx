import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { Switch } from "#renderer/components/Switch/Switch.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { MCP_SERVER_STATUS_WORDS } from "../../mcp-server-status-words.js";
import { PROVIDER_LABELS } from "#renderer/lib/provider-labels.js";
import { formatDateTime } from "#renderer/lib/wire/figures.js";
import type {
  McpServerBindingRef,
  McpServerInventoryEntry,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";
import type { SessionDirectoryState } from "#renderer/store/session-directory/session-directory.js";
import { ConfigReadBack } from "./ConfigReadBack.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";
import { toneForServerStatus } from "../server-status-tone.js";
import { ToolSettingList } from "./ToolSettingList.js";
import type { McpMutationOutcome } from "../mcp-mutation.js";

// Where a binding a person writes applies, in the words the add form offers for each scope.
const WHERE_IT_APPLIES: Readonly<Record<McpWritableBindingRef["scope"], string>> = {
  user: "On this machine, in every project",
  project: "In this project, saved with the repository",
  local: "In this project, on this machine only",
};

/**
 * One inventory row: the binding's identity, what is known about it, and the controls this
 * fixture body sends.
 *
 * The identity is the scope-qualified tuple, never the name: two same-named servers in two
 * scopes are two bindings, so provider, where it applies and its project or plugin are all on
 * screen. Every control is offered and none is eligibility-gated; each disables only while its
 * own call is in flight and settles in place under itself. A control whose reading the service
 * did not send is not drawn: `On for runs` without an `enabled`, and the per-tool rows while the
 * binding store is unreachable, where the row says so.
 */
export function ServerRow(props: {
  readonly entry: McpServerInventoryEntry;
  /** The outcome of the binding's own switch. */
  readonly outcome: McpMutationOutcome;
  readonly toolOutcomeFor: (toolName: string) => McpMutationOutcome;
  readonly onSetEnabled: (binding: McpServerBindingRef, enabled: boolean) => void;
  readonly onSetToolEnabled: (
    binding: McpServerBindingRef,
    toolName: string,
    enabled: boolean,
  ) => void;
  readonly sessionDirectory: SessionDirectoryState | undefined;
}): ReactNode {
  const { entry, outcome, toolOutcomeFor, onSetEnabled, onSetToolEnabled, sessionDirectory } =
    props;
  const binding = bindingOf(entry);
  const { enabled } = entry;
  return (
    <li className="meridian-mcp__row">
      <div className="meridian-mcp__row-identity">
        <WireFigure value={entry.serverName} />
        <Chip label={PROVIDER_LABELS[entry.provider]} />
        <Chip
          label={MCP_SERVER_STATUS_WORDS[entry.status]}
          tone={toneForServerStatus(entry.status)}
        />
        {entry.requiredServer === true ? <Chip label="Must start for a run to start" /> : null}
      </div>

      <div className="meridian-mcp__row-provenance">
        {binding.scope === "plugin" ? (
          <span className="meridian-settings-page__aside">
            Declared by plugin <WireFigure value={binding.scopeRef} />
          </span>
        ) : (
          <>
            <span className="meridian-settings-page__aside">{WHERE_IT_APPLIES[binding.scope]}</span>
            {binding.scope === "user" ? null : <WireFigure value={binding.scopeRef} />}
          </>
        )}
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

      {enabled === undefined ? null : (
        <div className="meridian-mcp__row-block">
          <Switch
            label="On for runs"
            checked={enabled}
            disabled={outcome.kind === "sending"}
            onCheckedChange={(checked) => {
              onSetEnabled(binding, checked);
            }}
          />
          <MutationOutcomeLine outcome={outcome} sessionDirectory={sessionDirectory} />
        </div>
      )}

      {entry.bindingStoreUnavailable === true ? (
        <Nothing
          kind="not-checked"
          placement="block"
          title={
            "Per-tool settings cannot be read right now. Those controls are not drawn because " +
            "the reading they act on did not arrive; everything else on this page is offered " +
            "exactly as usual."
          }
        />
      ) : (
        <ToolSettingList
          tools={entry.tools}
          outcomeFor={toolOutcomeFor}
          onSetToolEnabled={(toolName, toolEnabled) => {
            onSetToolEnabled(binding, toolName, toolEnabled);
          }}
          sessionDirectory={sessionDirectory}
        />
      )}
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
