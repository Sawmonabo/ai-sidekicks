import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { Switch } from "#renderer/components/Switch/Switch.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { MCP_SERVER_STATUS_WORDS } from "../../status-words.js";
import { PROVIDER_LABELS } from "#renderer/lib/provider-labels.js";
import type { Clock } from "#renderer/lib/clock.js";
import { formatRelativeTime } from "#renderer/lib/wire/figures.js";
import type {
  McpServerBindingRef,
  McpServerInventoryEntry,
  McpToolOverrideFacet,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { ConfigReadBack } from "./ConfigReadBack.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";
import { toneForServerStatus } from "../status-tone.js";
import { ToolSettingList } from "./ToolSettingList.js";
import type { McpMutationOutcome, McpToolFacetChange } from "../mutation.js";

// Where a binding a person writes applies, in the words the add form offers for each scope.
const WHERE_IT_APPLIES: Readonly<Record<McpWritableBindingRef["scope"], string>> = {
  user: "All projects",
  project: "This project · in the repo",
  local: "This project · not in the repo",
};

// What the degraded row says when the per-tool readings are missing, and when the binding's own
// switch is missing too.
const TOOL_READINGS_MISSING_LINE =
  "Per-tool settings cannot be read right now. Those controls are not drawn because the " +
  "reading they act on did not arrive; everything else on this page is offered exactly as usual.";
const SWITCH_AND_TOOL_READINGS_MISSING_LINE =
  "On for runs and the per-tool settings cannot be read right now. Those controls are not " +
  "drawn because the reading they act on did not arrive; everything else on this page is " +
  "offered exactly as usual.";

/**
 * One inventory row: the binding's identity, what is known about it, and the controls this
 * fixture body sends.
 *
 * The identity is the scope-qualified tuple, never the name: two same-named servers in two
 * scopes are two bindings, so provider, where it applies and its project or plugin are all on
 * screen, and a copy a project does not use says which one takes its place there, as the daemon
 * served it. Every control is offered and none is eligibility-gated; each disables only while its
 * own call is in flight and settles in place under itself. A control whose reading the service
 * did not send is not drawn: `On for runs` without an `enabled`, and the per-tool rows while the
 * binding store is unreachable, where the row names each one missing.
 */
export function ServerRow(props: {
  readonly entry: McpServerInventoryEntry;
  /** The outcome of the binding's own switch. */
  readonly outcome: McpMutationOutcome;
  readonly toolOutcomeFor: (toolName: string, facet: McpToolOverrideFacet) => McpMutationOutcome;
  readonly onSetEnabled: (binding: McpServerBindingRef, enabled: boolean) => void;
  readonly onChangeTool: (
    binding: McpServerBindingRef,
    toolName: string,
    facet: McpToolOverrideFacet,
    change: McpToolFacetChange,
  ) => void;
  readonly sessionDirectory: SessionDirectoryState | undefined;
  /** The window's clock: it counts each reading's age and holds an in-flight line back. */
  readonly clock: Clock;
}): ReactNode {
  const { entry, outcome, toolOutcomeFor, onSetEnabled, onChangeTool, sessionDirectory, clock } =
    props;
  const binding = bindingOf(entry);
  const { enabled } = entry;
  const nowMilliseconds = clock.now();
  return (
    <li className="meridian-mcp__row">
      <div className="meridian-mcp__row-identity">
        <WireFigure value={entry.serverName} />
        <Chip label={PROVIDER_LABELS[entry.provider]} />
        <Chip
          label={MCP_SERVER_STATUS_WORDS[entry.status]}
          tone={toneForServerStatus(entry.status)}
        />
        {entry.observedAt === undefined ? null : (
          <>
            <span className="meridian-settings-page__aside">updated</span>
            <DerivedFigure text={formatRelativeTime(entry.observedAt, nowMilliseconds)} />
          </>
        )}
        {entry.requiredServer === true ? <Chip label="Must start for a run to start" /> : null}
      </div>

      <div className="meridian-mcp__row-provenance">
        {binding.scope === "plugin" ? (
          <span className="meridian-settings-page__aside">
            From plugin <WireFigure value={binding.scopeRef} />
          </span>
        ) : (
          <>
            <span className="meridian-settings-page__aside">{WHERE_IT_APPLIES[binding.scope]}</span>
            {binding.scope === "user" ? null : <WireFigure value={binding.scopeRef} />}
          </>
        )}
      </div>

      {entry.supersededIn?.map((projectRoot) => (
        <p key={projectRoot} className="meridian-settings-page__aside">
          Not used in <WireFigure value={projectRoot} />: its own{" "}
          <WireFigure value={entry.serverName} /> takes its place.
        </p>
      ))}

      <ConfigReadBack config={entry.config} />

      <div className="meridian-mcp__row-block">
        <h4 className="meridian-mcp__row-block-title">Running sessions</h4>
        <ServerLegs
          legs={entry.legs}
          sessionDirectory={sessionDirectory}
          nowMilliseconds={nowMilliseconds}
        />
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
          <MutationOutcomeLine
            outcome={outcome}
            sessionDirectory={sessionDirectory}
            clock={clock}
          />
        </div>
      )}

      {entry.bindingStoreUnavailable === true ? (
        <Nothing
          kind="not-checked"
          placement="block"
          title={
            enabled === undefined
              ? SWITCH_AND_TOOL_READINGS_MISSING_LINE
              : TOOL_READINGS_MISSING_LINE
          }
        />
      ) : (
        <ToolSettingList
          tools={entry.tools}
          outcomeFor={toolOutcomeFor}
          onChangeTool={(toolName, facet, change) => {
            onChangeTool(binding, toolName, facet, change);
          }}
          sessionDirectory={sessionDirectory}
          clock={clock}
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
