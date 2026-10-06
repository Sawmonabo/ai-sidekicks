import type { ReactNode } from "react";

import { Switch } from "#renderer/components/Switch/Switch.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { McpToolReading, McpToolSettingSource } from "@ai-sidekicks/contracts/mcp/server";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import {
  APPROVAL_MODE_WORDS,
  IDEMPOTENCY_CLASS_WORDS,
  TOOL_SETTING_SOURCE_WORDS,
} from "../../tool-setting-words.js";
import type { McpMutationOutcome } from "../mutation.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";

/**
 * One row per tool a binding's server offers: its name, `On`, `Ask before running` and
 * `If a call is interrupted`, each value saying whether it is the server's own or set here.
 *
 * Every value and source is the daemon's resolution, drawn as served and worked out nowhere
 * here. `On` is offered on every tool and disables only while its own change is in flight; the
 * change settles in place under its row. The rows keep the order the daemon serves them in.
 */
export function ToolSettingList(props: {
  readonly tools: readonly McpToolReading[];
  readonly outcomeFor: (toolName: string) => McpMutationOutcome;
  readonly onSetToolEnabled: (toolName: string, enabled: boolean) => void;
  readonly sessionDirectory: SessionDirectoryState | undefined;
}): ReactNode {
  const { tools, outcomeFor, onSetToolEnabled, sessionDirectory } = props;
  if (tools.length === 0) {
    return null;
  }
  return (
    <ul className="meridian-mcp__tools">
      {tools.map((tool) => {
        const outcome = outcomeFor(tool.toolName);
        return (
          <li key={tool.toolName} className="meridian-mcp__tool">
            <WireFigure value={tool.toolName} />
            <span className="meridian-mcp__tool-setting">
              <Switch
                label="On"
                checked={tool.enabled.value}
                disabled={outcome.kind === "sending"}
                onCheckedChange={(enabled) => {
                  onSetToolEnabled(tool.toolName, enabled);
                }}
              />
              {renderSource(tool.enabled.source)}
            </span>
            {renderSetting(
              "Ask before running",
              APPROVAL_MODE_WORDS[tool.approvalMode.value],
              tool.approvalMode.source,
            )}
            {renderSetting(
              "If a call is interrupted",
              IDEMPOTENCY_CLASS_WORDS[tool.idempotencyClass.value],
              tool.idempotencyClass.source,
            )}
            <MutationOutcomeLine outcome={outcome} sessionDirectory={sessionDirectory} />
          </li>
        );
      })}
    </ul>
  );
}

/** One per-tool setting the row reads: its label, the value in force, and where it came from. */
function renderSetting(label: string, value: string, source: McpToolSettingSource): ReactNode {
  return (
    <span className="meridian-mcp__tool-setting">
      <span className="meridian-settings-page__aside">{label}</span>
      <span>{value}</span>
      {renderSource(source)}
    </span>
  );
}

function renderSource(source: McpToolSettingSource): ReactNode {
  return <span className="meridian-settings-page__aside">{TOOL_SETTING_SOURCE_WORDS[source]}</span>;
}
