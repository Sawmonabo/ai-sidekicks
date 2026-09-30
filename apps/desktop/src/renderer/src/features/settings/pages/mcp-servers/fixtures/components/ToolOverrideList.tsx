import type { ReactNode } from "react";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { McpToolOverride } from "@ai-sidekicks/contracts";

/**
 * The tool overrides pinned on one binding, by facet.
 *
 * An absent facet renders as an absence, never as a default: each facet is independently
 * optional and absent means "inherit", so filling the blank would re-derive a fallback the
 * daemon owns (`idempotencyClass` especially). The list is rendered in the order the daemon
 * serves it and never sorted.
 */
export function ToolOverrideList(props: {
  readonly overrides: readonly McpToolOverride[];
}): ReactNode {
  const { overrides } = props;
  if (overrides.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No tool on this binding carries an override."
        detail="Every tool it exposes is offered on the binding's own terms."
      />
    );
  }
  return (
    <ul className="meridian-mcp__overrides">
      {overrides.map((override) => (
        <li key={override.toolName} className="meridian-mcp__override">
          <WireFigure value={override.toolName} />
          {override.enabled === undefined ? null : (
            <Chip
              label={override.enabled ? "enabled" : "disabled"}
              tone={override.enabled ? "neutral" : "attention"}
            />
          )}
          {override.approvalMode === undefined ? null : <Chip label={override.approvalMode} mono />}
          {override.idempotencyClass === undefined ? null : (
            <Chip label={override.idempotencyClass} mono />
          )}
        </li>
      ))}
    </ul>
  );
}
