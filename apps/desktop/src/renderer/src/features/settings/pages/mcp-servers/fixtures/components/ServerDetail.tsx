import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { Switch } from "#renderer/components/Switch/Switch.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { MCP_SERVER_STATUS_WORDS } from "../../status-words.js";
import type { Clock } from "#renderer/lib/clock.js";
import type {
  McpServerBindingRef,
  McpServerInventoryEntry,
  McpToolOverrideFacet,
} from "@ai-sidekicks/contracts/mcp/server";
import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import type { ProjectListState } from "#renderer/store/projects/list.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { ConfigReadBack } from "./ConfigReadBack.js";
import { ProjectSwitches } from "./ProjectSwitches.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { ServerLegs } from "./ServerLegs.js";
import { toneForServerStatus } from "../status-tone.js";
import { ToolSettingList } from "./ToolSettingList.js";
import type {
  McpMutationOutcome,
  McpProjectScopedBindingRef,
  McpSwitchableBindingRef,
  McpToolFacetChange,
} from "../mutation.js";

// What the degraded server says when the per-tool readings are missing, and when the binding's
// own switch is missing too.
const TOOL_READINGS_MISSING_LINE =
  "Per-tool settings cannot be read right now. Those controls are not drawn because the " +
  "reading they act on did not arrive; everything else on this page is offered exactly as usual.";
const SWITCH_AND_TOOL_READINGS_MISSING_LINE =
  "On for runs and the per-tool settings cannot be read right now. Those controls are not " +
  "drawn because the reading they act on did not arrive; everything else on this page is " +
  "offered exactly as usual.";

/**
 * The selected server: its state with the probe's reason where one decides it, its set-up read
 * back, one reading per running session under `Running sessions`, then the controls this fixture
 * body sends. With nothing selected it says how to pick one.
 *
 * Every control is offered and none is eligibility-gated; each disables only while its own call
 * is in flight and settles in place under itself. A control whose reading the service did not
 * send is not drawn: `On for runs` without an `enabled`, and the per-tool rows while the binding
 * store is unreachable, where the pane names each one missing. A connector's or an
 * organization's server carries `On for runs` once per attached project.
 */
export function ServerDetail(props: {
  readonly entry: McpServerInventoryEntry | undefined;
  /** The outcome of the binding's own switch. */
  readonly outcome: McpMutationOutcome;
  readonly toolOutcomeFor: (toolName: string, facet: McpToolOverrideFacet) => McpMutationOutcome;
  readonly onSetEnabled: (binding: McpSwitchableBindingRef, enabled: boolean) => void;
  /** The service's projects, one `On for runs` switch each on a project-scoped server. */
  readonly projects: ProjectListState;
  /** The outcome of one project's `On for runs` switch. */
  readonly projectSwitchOutcomeFor: (project: ProjectListEntry) => McpMutationOutcome;
  readonly onSetEnabledIn: (
    binding: McpProjectScopedBindingRef,
    project: ProjectListEntry,
    enabled: boolean,
  ) => void;
  /** The outcome of `Sign in to this server`. */
  readonly signInOutcome: McpMutationOutcome;
  readonly onSignIn: (binding: McpServerBindingRef) => void;
  readonly onChangeTool: (
    binding: McpServerBindingRef,
    toolName: string,
    facet: McpToolOverrideFacet,
    change: McpToolFacetChange,
  ) => void;
  readonly sessionDirectory: SessionDirectoryState;
  /** The window's clock, which holds an in-flight line back for the short delay. */
  readonly clock: Clock;
  /** The instant each reading's age is counted to, in epoch milliseconds. */
  readonly nowMilliseconds: number;
}): ReactNode {
  const {
    entry,
    outcome,
    toolOutcomeFor,
    onSetEnabled,
    projects,
    projectSwitchOutcomeFor,
    onSetEnabledIn,
    signInOutcome,
    onSignIn,
    onChangeTool,
    sessionDirectory,
    clock,
  } = props;
  if (entry === undefined) {
    return (
      <section className="meridian-mcp__detail" aria-label="Selected server">
        <Nothing
          kind="empty"
          placement="block"
          title="Pick a server on the left to see what it is allowed to do."
        />
      </section>
    );
  }
  const binding = bindingOf(entry);
  const { enabled } = entry;
  return (
    <section className="meridian-mcp__detail" aria-label="Selected server">
      <div className="meridian-mcp__detail-head">
        <h3 className="meridian-mcp__detail-title">
          <WireFigure value={entry.serverName} />
        </h3>
        <Chip
          label={MCP_SERVER_STATUS_WORDS[entry.status]}
          tone={toneForServerStatus(entry.status)}
        />
        {entry.config.transport !== "ws" && entry.config.required === true ? (
          <Chip label="Must start for a run to start" />
        ) : null}
      </div>
      {entry.probeFailureReason === undefined ? null : (
        <p className="meridian-settings-page__aside">
          <WireFigure value={entry.probeFailureReason} />
        </p>
      )}

      <ConfigReadBack config={entry.config} />

      <div className="meridian-mcp__detail-block">
        <h4 className="meridian-settings-page__section-head">Running sessions</h4>
        <ServerLegs
          legs={entry.legs}
          sessionDirectory={sessionDirectory}
          nowMilliseconds={props.nowMilliseconds}
        />
      </div>

      {enabled === undefined ? null : binding.scope === "connector" ||
        binding.scope === "managed" ? (
        <ProjectSwitches
          entry={entry}
          projects={projects}
          outcomeFor={projectSwitchOutcomeFor}
          onSetEnabledIn={(project, checked) => {
            onSetEnabledIn(binding, project, checked);
          }}
          sessionDirectory={sessionDirectory}
          clock={clock}
        />
      ) : (
        <div className="meridian-mcp__detail-block">
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

      <div className="meridian-mcp__detail-block">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={() => {
            onSignIn(binding);
          }}
        >
          Sign in to this server
        </button>
        <MutationOutcomeLine
          outcome={signInOutcome}
          sessionDirectory={sessionDirectory}
          clock={clock}
          onTryAgain={() => {
            onSignIn(binding);
          }}
        />
      </div>

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
    </section>
  );
}

/**
 * The binding identity carried inside one inventory entry.
 *
 * Rebuilt per arm rather than spread, so the discriminated union stays discriminated and no
 * cast is needed to keep a `scopeRef` off the arms that have none.
 */
function bindingOf(entry: McpServerInventoryEntry): McpServerBindingRef {
  const { provider, serverName } = entry;
  switch (entry.scope) {
    case "user":
    case "managed":
      return { provider, scope: entry.scope, serverName };
    case "project":
    case "local":
      return entry.place === undefined
        ? { provider, scope: entry.scope, scopeRef: entry.scopeRef, serverName }
        : {
            provider,
            scope: entry.scope,
            scopeRef: entry.scopeRef,
            place: entry.place,
            serverName,
          };
    case "plugin":
      return { provider, scope: "plugin", scopeRef: entry.scopeRef, serverName };
    case "connector":
      return { provider, scope: "connector", scopeRef: entry.scopeRef, serverName };
  }
}
