import type { ReactNode } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { Switch } from "#renderer/components/Switch/Switch.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import type { Clock } from "#renderer/lib/clock.js";
import {
  MCP_APPROVAL_MODES,
  type McpToolOverrideFacet,
  type McpToolReading,
  type McpToolSetting,
} from "@ai-sidekicks/contracts/mcp/server";
import { IDEMPOTENCY_CLASSES } from "@ai-sidekicks/contracts/provider/driver/tools";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import {
  APPROVAL_MODE_WORDS,
  IDEMPOTENCY_CLASS_WORDS,
  TOOL_SETTING_SOURCE_WORDS,
} from "../../tool-setting-words.js";
import type { McpMutationOutcome, McpToolFacetChange } from "../mutation.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";

/**
 * One row per tool a binding's server offers: its name, `On`, `Ask before running` and
 * `If a call is interrupted`, each value saying whether it is the server's own or set here.
 *
 * Every value and source is the daemon's resolution, drawn as served and worked out nowhere
 * here. Each control lists only its facet's values; choosing the server's own value while one set
 * here is in force clears that facet alone, and choosing any other value sets it. Each control
 * disables only while its own change is in flight and settles in place under itself. The rows
 * keep the order the daemon serves them in.
 */
export function ToolSettingList(props: {
  readonly tools: readonly McpToolReading[];
  readonly outcomeFor: (toolName: string, facet: McpToolOverrideFacet) => McpMutationOutcome;
  readonly onChangeTool: (
    toolName: string,
    facet: McpToolOverrideFacet,
    change: McpToolFacetChange,
  ) => void;
  readonly sessionDirectory: SessionDirectoryState;
  /** The window's clock, which holds an in-flight line back for the short delay. */
  readonly clock: Clock;
}): ReactNode {
  const { tools, outcomeFor, onChangeTool, sessionDirectory, clock } = props;
  const scrollerRef = useDrawOverlayScrollbar<HTMLDivElement>();
  if (tools.length === 0) {
    return <Nothing kind="empty" placement="inline" title="No tools listed for this server." />;
  }
  return (
    <div className="meridian-mcp__scroller" ref={scrollerRef}>
      <ul className="meridian-mcp__tools">
        {tools.map((tool) => {
          const outcomeLine = (facet: McpToolOverrideFacet): ReactNode => (
            <MutationOutcomeLine
              outcome={outcomeFor(tool.toolName, facet)}
              sessionDirectory={sessionDirectory}
              clock={clock}
            />
          );
          const isSending = (facet: McpToolOverrideFacet): boolean =>
            outcomeFor(tool.toolName, facet).kind === "sending";
          return (
            <li key={tool.toolName} className="meridian-mcp__tool">
              <WireFigure value={tool.toolName} />
              <div className="meridian-mcp__tool-setting">
                <Switch
                  label="On"
                  checked={tool.enabled.value}
                  disabled={isSending("enabled")}
                  onCheckedChange={(enabled) => {
                    onChangeTool(
                      tool.toolName,
                      "enabled",
                      enabled === serverValueOf(tool.enabled)
                        ? { kind: "clear" }
                        : { kind: "set", override: { enabled } },
                    );
                  }}
                />
                {renderSource(tool.enabled)}
              </div>
              {outcomeLine("enabled")}
              <div className="meridian-mcp__tool-setting">
                <label className="meridian-mcp__tool-choice">
                  <span className="meridian-settings-page__aside">Ask before running</span>
                  <select
                    className="meridian-form__input"
                    value={tool.approvalMode.value}
                    disabled={isSending("approvalMode")}
                    onChange={(event) => {
                      const approvalMode = MCP_APPROVAL_MODES.find(
                        (mode) => mode === event.currentTarget.value,
                      );
                      if (approvalMode === undefined) {
                        return;
                      }
                      onChangeTool(
                        tool.toolName,
                        "approvalMode",
                        approvalMode === serverValueOf(tool.approvalMode)
                          ? { kind: "clear" }
                          : { kind: "set", override: { approvalMode } },
                      );
                    }}
                  >
                    {MCP_APPROVAL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {APPROVAL_MODE_WORDS[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                {renderSource(tool.approvalMode)}
              </div>
              {outcomeLine("approvalMode")}
              <div className="meridian-mcp__tool-setting">
                <label className="meridian-mcp__tool-choice">
                  <span className="meridian-settings-page__aside">If a call is interrupted</span>
                  <select
                    className="meridian-form__input"
                    value={tool.idempotencyClass.value}
                    disabled={isSending("idempotencyClass")}
                    onChange={(event) => {
                      const idempotencyClass = IDEMPOTENCY_CLASSES.find(
                        (candidate) => candidate === event.currentTarget.value,
                      );
                      if (idempotencyClass === undefined) {
                        return;
                      }
                      onChangeTool(
                        tool.toolName,
                        "idempotencyClass",
                        idempotencyClass === serverValueOf(tool.idempotencyClass)
                          ? { kind: "clear" }
                          : { kind: "set", override: { idempotencyClass } },
                      );
                    }}
                  >
                    {IDEMPOTENCY_CLASSES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {IDEMPOTENCY_CLASS_WORDS[candidate]}
                      </option>
                    ))}
                  </select>
                </label>
                {renderSource(tool.idempotencyClass)}
              </div>
              {outcomeLine("idempotencyClass")}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The value clearing a facet returns to: the one in force, or the server's own under an override.
 */
function serverValueOf<OverrideValue, ServerValue>(
  setting: McpToolSetting<OverrideValue, ServerValue>,
): ServerValue {
  return setting.source === "server" ? setting.value : setting.serverValue;
}

function renderSource(setting: McpToolSetting<unknown>): ReactNode {
  return (
    <span className="meridian-settings-page__aside">
      {TOOL_SETTING_SOURCE_WORDS[setting.source]}
    </span>
  );
}
